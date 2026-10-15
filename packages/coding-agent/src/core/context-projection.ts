/**
 * Request-time projection of the session branch into the messages one model sees.
 *
 * The canonical projection (`buildSessionProjection`) applies persisted edits and visibility.
 * `projectContext` lets an extension derive one request's copy from it: drop entries, bring
 * omitted ones back, and move content to the tail, within the compaction budget. When the copy
 * would cross the threshold, additions are evicted first, then canonical content whose entry
 * declares a priority; content without a declared priority is never evicted.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import { estimateMessagesTokens } from "./compaction/compaction.ts";
import type { CustomMessage, FieldKey } from "./messages.ts";
import {
	type OmittedReason,
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
 *   position. Omitted entries default to "tail"; present ones keep their canonical placement, so
 *   a `position: "tail"` message stays at the tail. `priority` orders the eviction of an omitted
 *   entry brought back; a present entry keeps its declared priority
 */
export type ProjectionDecision =
	| "default"
	| "omit"
	| { include: true; priority?: number; placement?: "tail" | "in_place" };

export interface ProjectionEntryInfo {
	/** Why the entry contributes nothing to the canonical projection although it has content. */
	omitted?: OmittedReason;
	/** Estimated tokens of the entry's content. */
	tokens: number;
	/** Annotations resolved for the entry over the branch, or `{}`. */
	annotations: Record<FieldKey, JsonValue>;
}

export type ProjectionFilter = (entry: ProjectedSessionEntry, info: ProjectionEntryInfo) => ProjectionDecision;

export interface ProjectedContext {
	messages: AgentMessage[];
	/** Estimated tokens of `messages`, from the baseline and the estimated difference. */
	tokens: number;
	budget: ContextBudget;
	/**
	 * Contributions dropped to stay under the threshold: additions first, then canonical content
	 * with a declared priority; lowest priority and oldest first within each kind.
	 */
	evicted: { entry: ProjectedSessionEntry; tokens: number; kind: "addition" | "canonical" }[];
}

export const CONTEXT_RECALL_TYPE = "context_recall";

export function completeBudget(budget: Omit<ContextBudget, "available">): ContextBudget {
	return { ...budget, available: budget.contextWindow - budget.reserveTokens - budget.baselineTokens };
}

/** One entry's part of the copy. Evictable when `priority` is set; evicted ones lose their messages. */
interface Contribution {
	index: number;
	entry: ProjectedSessionEntry;
	messages: AgentMessage[];
	/** Eviction order: the filter's for an addition, the entry's declared one for canonical content. */
	priority?: number;
	placement: "tail" | "in_place";
	/** An addition brings an omitted entry back; canonical content is a present entry's, in place or re-sent. */
	kind: "addition" | "canonical";
}

function isEvictable(contribution: Contribution): contribution is Contribution & { priority: number } {
	return contribution.priority !== undefined && contribution.messages.length > 0;
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
		ref: entry.sourceEntry.id,
		timestamp: Date.now(),
	};
}

/**
 * Keep each tool-call group contiguous: an assistant message's calls, then their results. A result
 * whose call is not in the open group is dropped. Any other message inside an open group (sessions
 * recorded before #8537 put custom messages there) moves after the group's results, so nothing
 * else is dropped. Only an assistant or user message closes a group.
 */
function orderToolCallGroups(messages: AgentMessage[]): AgentMessage[] {
	const ordered: AgentMessage[] = [];
	let openCalls = new Set<string>();
	let unanswered = new Set<string>();
	let deferred: AgentMessage[] = [];
	const flush = () => {
		ordered.push(...deferred);
		deferred = [];
	};
	for (const message of messages) {
		if (message.role === "assistant" || message.role === "user") {
			flush();
			const calls =
				message.role === "assistant"
					? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
					: [];
			openCalls = new Set(calls);
			unanswered = new Set(calls);
			ordered.push(message);
		} else if (message.role === "toolResult") {
			if (!openCalls.has(message.toolCallId)) continue;
			ordered.push(message);
			unanswered.delete(message.toolCallId);
			if (unanswered.size === 0) flush();
		} else if (unanswered.size > 0) {
			deferred.push(message);
		} else {
			ordered.push(message);
		}
	}
	flush();
	return ordered;
}

export function projectContext(
	projection: SessionProjection,
	budget: Omit<ContextBudget, "available">,
	filter?: ProjectionFilter,
): ProjectedContext {
	// A model without a known window never evicts, as the session never compacts for it either.
	const threshold = budget.contextWindow > 0 ? budget.contextWindow - budget.reserveTokens : Infinity;
	const fullBudget = completeBudget(budget);
	const contributions: Contribution[] = [];
	let tokens = budget.baselineTokens;

	projection.entries.forEach((entry, index) => {
		// Canonical tail messages keep their request position after everything else.
		const tail = entry.sourceEntry.type === "custom_message" && entry.sourceEntry.position === "tail";
		const canonical: Contribution = {
			index,
			entry,
			messages: entry.messages,
			priority: entry.priority,
			placement: tail ? "tail" : "in_place",
			kind: "canonical",
		};
		// A superseded compaction summary is stale, not omitted, and the live one is the checkpoint
		// the copy starts from: neither is offered to the filter or evicted.
		if (entry.sourceEntry.type === "compaction") {
			contributions.push({ ...canonical, priority: undefined });
			return;
		}
		const source = entry.omitted ? sessionEntryToContextMessages(entry.sourceEntry) : entry.messages;
		const decision =
			filter?.(entry, {
				omitted: entry.omitted,
				tokens: estimateMessagesTokens(source),
				annotations: projection.annotations.get(entry.sourceEntry.id) ?? {},
			}) ?? "default";
		if (decision === "omit") {
			tokens -= estimateMessagesTokens(entry.messages);
			return;
		}
		if (decision === "default" || source.length === 0) {
			contributions.push(canonical);
			return;
		}
		if (!entry.omitted && decision.placement !== "tail") {
			// A present entry keeps its canonical placement unless asked to move; "in_place" moves a
			// tail message into its branch position.
			contributions.push(decision.placement === "in_place" ? { ...canonical, placement: "in_place" } : canonical);
			return;
		}
		// An omitted entry comes back at the tail by default; a present one is only re-sent there.
		const placement = decision.placement ?? "tail";
		const recalled = placement === "tail" ? recallMessage(entry, source) : undefined;
		const messages = placement === "tail" ? (recalled ? [recalled] : []) : source;
		if (entry.omitted) {
			contributions.push({ index, entry, messages, priority: decision.priority ?? 0, placement, kind: "addition" });
			tokens += estimateMessagesTokens(messages);
		} else {
			// A present entry re-sent at the tail is still its canonical content, under its own priority.
			contributions.push({ ...canonical, messages, placement: "tail" });
			tokens += estimateMessagesTokens(messages) - estimateMessagesTokens(entry.messages);
		}
	});

	const evicted: ProjectedContext["evicted"] = [];
	for (const kind of ["addition", "canonical"] as const) {
		const candidates = contributions
			.filter(isEvictable)
			.filter((contribution) => contribution.kind === kind)
			.sort((a, b) => a.priority - b.priority || a.index - b.index);
		for (const candidate of candidates) {
			if (tokens <= threshold) break;
			const cost = estimateMessagesTokens(candidate.messages);
			tokens -= cost;
			candidate.messages = [];
			evicted.push({ entry: candidate.entry, tokens: cost, kind });
		}
	}

	const inPlace = contributions.filter((contribution) => contribution.placement === "in_place");
	const tail = contributions.filter((contribution) => contribution.placement === "tail");
	const ordered = [...inPlace, ...tail].flatMap((contribution) => contribution.messages);
	const messages = orderToolCallGroups(ordered);
	return {
		messages,
		tokens: tokens - estimateMessagesTokens(ordered) + estimateMessagesTokens(messages),
		budget: fullBudget,
		evicted,
	};
}
