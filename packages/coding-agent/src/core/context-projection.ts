/**
 * Request-time projection of the session branch into the messages one model sees.
 *
 * The canonical projection (`buildSessionProjection`) applies persisted edits and visibility.
 * `projectContext` lets an extension derive one request's copy from it: drop entries, bring
 * omitted ones back, and move content to the tail, within the compaction budget. Additions
 * are evicted first when the copy would cross the threshold; canonical messages never are.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { estimateMessagesTokens } from "./compaction/compaction.ts";
import type { CustomMessage } from "./messages.ts";
import {
	type ProjectedSessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "./session-manager.ts";

/** Token budget of one request, measured against the compaction threshold. */
export interface ContextBudget {
	contextWindow: number;
	reserveTokens: number;
	/** Estimated tokens of the canonical projection. */
	baselineTokens: number;
	/** Tokens left under the threshold for additions. Zero or negative right before compaction. */
	available: number;
}

/**
 * What one entry contributes to the copy.
 * - `default`: the canonical contribution, so an omitted entry stays out
 * - `omit`: nothing
 * - include: the canonical contribution of a present entry, or the source content of an omitted
 *   one. `placement` "tail" re-sends the content after every other message as a custom message,
 *   which keeps the cached prefix and the tool-call order intact; "in_place" keeps the branch
 *   position. Omitted entries default to "tail", present ones to "in_place"
 */
export type ProjectionDecision =
	| "default"
	| "omit"
	| { include: true; priority?: number; placement?: "tail" | "in_place" };

export interface ProjectionEntryInfo {
	/** The entry contributes nothing to the canonical projection although it has content. */
	omitted: boolean;
	/** Estimated tokens of the entry's content. */
	tokens: number;
}

export type ProjectionFilter = (entry: ProjectedSessionEntry, info: ProjectionEntryInfo) => ProjectionDecision;

export interface ProjectedContext {
	messages: AgentMessage[];
	/** Estimated tokens of `messages`, from the baseline and the estimated difference. */
	tokens: number;
	budget: ContextBudget;
	/** Additions dropped to stay under the threshold, lowest priority and oldest first. */
	evicted: { entry: ProjectedSessionEntry; tokens: number }[];
}

export const CONTEXT_RECALL_TYPE = "context_recall";

export function completeBudget(budget: Omit<ContextBudget, "available">): ContextBudget {
	return { ...budget, available: budget.contextWindow - budget.reserveTokens - budget.baselineTokens };
}

interface Addition {
	index: number;
	entry: ProjectedSessionEntry;
	messages: AgentMessage[];
	tokens: number;
	priority: number;
	placement: "tail" | "in_place";
}

function contentBlocks(message: AgentMessage): (TextContent | ImageContent)[] {
	switch (message.role) {
		case "user":
		case "custom":
			return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		case "assistant":
			return message.content.filter((block): block is TextContent => block.type === "text");
		case "toolResult":
			return message.content;
		case "compactionSummary":
		case "branchSummary":
			return [{ type: "text", text: message.summary }];
		default:
			return [];
	}
}

/** Re-send an entry's content after the transcript as one custom message. */
function recallMessage(entry: ProjectedSessionEntry, messages: AgentMessage[]): CustomMessage | undefined {
	const content = messages.flatMap(contentBlocks);
	if (content.length === 0) return undefined;
	return {
		role: "custom",
		customType: CONTEXT_RECALL_TYPE,
		content,
		display: false,
		details: { entryId: entry.sourceEntry.id },
		timestamp: Date.now(),
	};
}

/** Drop tool results whose call is not in the assistant message they follow. */
function dropOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
	let openCalls = new Set<string>();
	return messages.filter((message) => {
		if (message.role === "assistant") {
			openCalls = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
			return true;
		}
		if (message.role === "toolResult") return openCalls.has(message.toolCallId);
		openCalls = new Set();
		return true;
	});
}

export function projectContext(
	projection: SessionProjection,
	budget: Omit<ContextBudget, "available">,
	filter?: ProjectionFilter,
): ProjectedContext {
	const threshold = budget.contextWindow - budget.reserveTokens;
	const fullBudget = completeBudget(budget);
	const kept: AgentMessage[][] = [];
	const moved: Addition[] = [];
	const additions: Addition[] = [];
	let tokens = budget.baselineTokens;

	projection.entries.forEach((entry, index) => {
		// A superseded compaction summary is stale, not omitted; it is never offered to the filter.
		if (entry.sourceEntry.type === "compaction") {
			kept.push(entry.messages);
			return;
		}
		const source = entry.messages.length === 0 ? sessionEntryToContextMessages(entry.sourceEntry) : entry.messages;
		const omitted = entry.messages.length === 0 && source.length > 0;
		const decision = filter?.(entry, { omitted, tokens: estimateMessagesTokens(source) }) ?? "default";
		if (decision === "omit") {
			tokens -= estimateMessagesTokens(entry.messages);
			kept.push([]);
			return;
		}
		if (decision === "default" || source.length === 0) {
			// Canonical tail messages keep their request position after everything else.
			if (entry.sourceEntry.type === "custom_message" && entry.sourceEntry.position === "tail") {
				kept.push([]);
				moved.push({ index, entry, messages: entry.messages, tokens: 0, priority: 0, placement: "tail" });
			} else {
				kept.push(entry.messages);
			}
			return;
		}
		const placement = decision.placement ?? (omitted ? "tail" : "in_place");
		const recalled = placement === "tail" ? recallMessage(entry, source) : undefined;
		const messages = placement === "tail" ? (recalled ? [recalled] : []) : source;
		const addition: Addition = {
			index,
			entry,
			messages,
			tokens: estimateMessagesTokens(messages),
			priority: decision.priority ?? 0,
			placement,
		};
		if (omitted) {
			kept.push([]);
			additions.push(addition);
			tokens += addition.tokens;
		} else if (placement === "tail") {
			kept.push([]);
			moved.push(addition);
			tokens += addition.tokens - estimateMessagesTokens(entry.messages);
		} else {
			kept.push(entry.messages);
		}
	});

	const evicted: ProjectedContext["evicted"] = [];
	while (tokens > threshold && additions.length > 0) {
		let victim = 0;
		for (let i = 1; i < additions.length; i++) {
			const a = additions[i];
			const b = additions[victim];
			if (a.priority < b.priority || (a.priority === b.priority && a.index < b.index)) victim = i;
		}
		const [dropped] = additions.splice(victim, 1);
		tokens -= dropped.tokens;
		evicted.push({ entry: dropped.entry, tokens: dropped.tokens });
	}

	for (const addition of additions) {
		if (addition.placement === "in_place") kept[addition.index] = addition.messages;
	}
	const tail = [...moved, ...additions.filter((addition) => addition.placement === "tail")]
		.sort((a, b) => a.index - b.index)
		.flatMap((addition) => addition.messages);
	const ordered = [...kept.flat(), ...tail];
	const messages = dropOrphanedToolResults(ordered);
	return {
		messages,
		tokens: tokens - estimateMessagesTokens(ordered) + estimateMessagesTokens(messages),
		budget: fullBudget,
		evicted,
	};
}
