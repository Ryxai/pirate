/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, Message, TextContent } from "@earendil-works/pi-ai";
import { type FieldKey, isFieldRecord } from "./fields.ts";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * When a bounded contribution leaves model context. Conditions are evaluated over the entries
 * that follow it on the active branch, so they hold after resume and on every branch.
 * - `assistant_message`: sent with one request, dropped once the model has answered
 * - `user_message`: kept through the tool-call turns of the current run
 * - `compaction`: dropped at the next compaction, whether or not it keeps the entry
 * - `{ assistantMessages: n }`: dropped after the n-th assistant response
 * - `{ customType }`: dropped once a custom entry or custom message of that type follows
 * - `{ tokens: n }`: dropped once the estimated tokens of the entries that followed exceed n
 */
export type ContextExpiry =
	| "assistant_message"
	| "user_message"
	| "compaction"
	| { assistantMessages: number }
	| { customType: string }
	| { tokens: number };

/**
 * Lifetime of a custom message, or of a context edit's contribution, in model context. A context
 * edit keeps its target's visibility unless it carries its own; `{}` makes it permanent.
 */
export interface ContextVisibility {
	until?: ContextExpiry;
	/** A later custom message with the same key supersedes this one. */
	key?: string;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
/** Fields of a custom message that callers supply; Pi adds the role and timestamp. */
export interface CustomMessageInput<T = unknown> {
	customType: string;
	/** Required unless `ref` is set, which copies the referenced entry's content instead. */
	content?: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Omitted: the message stays in model context like any other. */
	visibility?: ContextVisibility;
	/** "tail" projects the message after every other message of the request, whatever its branch position. */
	position?: "tail";
	/** Eviction order under pressure; omitted means conversation, never evicted. */
	priority?: number;
	/** Entry this message re-sends; its content was copied when the message was appended. */
	ref?: string;
	/** Extension-owned values by FieldKey. Pi never interprets them. */
	fields?: Record<FieldKey, JsonValue>;
}

export interface CustomMessage<T = unknown> extends CustomMessageInput<T> {
	role: "custom";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** The projection fields of a custom message input that are set and well-formed. */
export function customMessageOptions(
	message: CustomMessageInput,
): Pick<CustomMessage, "visibility" | "position" | "priority" | "ref" | "fields"> {
	return {
		...(message.visibility ? { visibility: message.visibility } : {}),
		...(message.position ? { position: message.position } : {}),
		...(typeof message.priority === "number" ? { priority: message.priority } : {}),
		...(typeof message.ref === "string" ? { ref: message.ref } : {}),
		...(isFieldRecord(message.fields) ? { fields: message.fields } : {}),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(message: CustomMessageInput, timestamp: string): CustomMessage {
	return {
		role: "custom",
		customType: message.customType,
		// Session files are parsed without validation; old or hand-edited files can lack content.
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		...customMessageOptions(message),
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "system":
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
