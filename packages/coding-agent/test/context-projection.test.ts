import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CONTEXT_RECALL_TYPE, projectContext } from "../src/core/context-projection.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text: string, toolCallId?: string): AssistantMessage {
	return {
		role: "assistant",
		content: toolCallId
			? [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } }]
			: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallId ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

const BUDGET = { contextWindow: 100_000, reserveTokens: 10_000, baselineTokens: 1_000 };

function session(): { manager: SessionManager; preludeId: string; assistantId: string } {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
	const preludeId = manager.appendCustomMessageEntry("prelude", "think first", false, undefined, {
		until: "assistant_message",
	});
	const assistantId = manager.appendMessage(assistant("", "call-1"));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: Date.now(),
	});
	manager.appendMessage(assistant("done"));
	manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
	return { manager, preludeId, assistantId };
}

function roles(messages: { role: string }[]): string[] {
	return messages.map((message) => message.role);
}

describe("projectContext", () => {
	it("returns the canonical projection without a filter and reports the budget", () => {
		const { manager } = session();
		const projection = manager.buildSessionProjection();
		const result = projectContext(projection, BUDGET);
		expect(result.messages).toEqual(projection.messages);
		expect(result.tokens).toBe(BUDGET.baselineTokens);
		expect(result.budget).toEqual({ ...BUDGET, available: 89_000 });
		expect(result.evicted).toEqual([]);
	});

	it("tells the filter which entries are omitted and what they cost", () => {
		const { manager, preludeId } = session();
		const seen = new Map<string, { omitted: boolean; tokens: number }>();
		projectContext(manager.buildSessionProjection(), BUDGET, (entry, info) => {
			seen.set(entry.sourceEntry.id, info);
			return "default";
		});
		expect(seen.get(preludeId)).toMatchObject({ omitted: true });
		expect(seen.get(preludeId)!.tokens).toBeGreaterThan(0);
		expect([...seen.values()].filter((info) => info.omitted)).toHaveLength(1);
	});

	it("re-sends an omitted entry at the tail as a recall message by default", () => {
		const { manager, preludeId } = session();
		const result = projectContext(manager.buildSessionProjection(), BUDGET, (entry) =>
			entry.sourceEntry.id === preludeId ? { include: true } : "default",
		);
		expect(roles(result.messages)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "custom"]);
		expect(result.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: CONTEXT_RECALL_TYPE,
			content: [{ type: "text", text: "think first" }],
			details: { entryId: preludeId },
		});
		expect(result.tokens).toBeGreaterThan(BUDGET.baselineTokens);
	});

	it("puts an omitted entry back in place when asked", () => {
		const { manager, preludeId } = session();
		const result = projectContext(manager.buildSessionProjection(), BUDGET, (entry) =>
			entry.sourceEntry.id === preludeId ? { include: true, placement: "in_place" } : "default",
		);
		expect(roles(result.messages)).toEqual(["user", "custom", "assistant", "toolResult", "assistant", "user"]);
		expect(result.messages[1]).toMatchObject({ role: "custom", customType: "prelude" });
	});

	it("drops tool results whose call was omitted", () => {
		const { manager, assistantId } = session();
		const result = projectContext(manager.buildSessionProjection(), BUDGET, (entry) =>
			entry.sourceEntry.id === assistantId ? "omit" : "default",
		);
		expect(roles(result.messages)).toEqual(["user", "assistant", "user"]);
		expect(result.tokens).toBeLessThan(BUDGET.baselineTokens);
	});

	it("evicts additions lowest priority first, then oldest, to stay under the threshold", () => {
		const manager = SessionManager.inMemory();
		const low = manager.appendCustomMessageEntry("note", "a".repeat(400), false, undefined, {
			until: "assistant_message",
		});
		const high = manager.appendCustomMessageEntry("note", "b".repeat(400), false, undefined, {
			until: "assistant_message",
		});
		const other = manager.appendCustomMessageEntry("note", "c".repeat(400), false, undefined, {
			until: "assistant_message",
		});
		manager.appendMessage(assistant("answer"));
		const projection = manager.buildSessionProjection();
		const priorities = new Map([
			[low, 0],
			[high, 1],
			[other, 1],
		]);
		const filter = (entry: { sourceEntry: { id: string } }) => {
			const priority = priorities.get(entry.sourceEntry.id);
			return priority === undefined ? "default" : { include: true as const, priority };
		};
		const cost = new Map<string, number>();
		projectContext(projection, BUDGET, (entry, info) => {
			cost.set(entry.sourceEntry.id, info.tokens);
			return filter(entry);
		});
		const total = cost.get(low)! + cost.get(high)! + cost.get(other)!;

		const fits = projectContext(
			projection,
			{ ...BUDGET, reserveTokens: 0, contextWindow: BUDGET.baselineTokens + total },
			filter,
		);
		expect(fits.evicted).toEqual([]);
		expect(roles(fits.messages)).toEqual(["assistant", "custom", "custom", "custom"]);

		const oneShort = projectContext(
			projection,
			{ ...BUDGET, reserveTokens: 0, contextWindow: BUDGET.baselineTokens + total - 1 },
			filter,
		);
		expect(oneShort.evicted.map((item) => item.entry.sourceEntry.id)).toEqual([low]);
		expect(oneShort.tokens).toBe(BUDGET.baselineTokens + total - cost.get(low)!);

		const twoShort = projectContext(
			projection,
			{ ...BUDGET, reserveTokens: 0, contextWindow: BUDGET.baselineTokens + total - cost.get(low)! - 1 },
			filter,
		);
		expect(twoShort.evicted.map((item) => item.entry.sourceEntry.id)).toEqual([low, high]);
		expect(roles(twoShort.messages)).toEqual(["assistant", "custom"]);
	});
});
