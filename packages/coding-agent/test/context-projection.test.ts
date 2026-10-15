import { fauxAssistantMessage, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CONTEXT_RECALL_TYPE, type ProjectionFilter, projectContext } from "../src/core/context-projection.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const BUDGET = { contextWindow: 100_000, reserveTokens: 10_000, baselineTokens: 1_000 };

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function toolCallTurn(session: SessionManager, id: string, text: string): string {
	const assistantId = session.appendMessage(
		fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id })], { stopReason: "toolUse" }),
	);
	session.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	});
	return assistantId;
}

function session(): { manager: SessionManager; preludeId: string; assistantId: string } {
	const manager = SessionManager.inMemory();
	manager.appendMessage(user("request"));
	const preludeId = manager.appendCustomMessageEntry({
		customType: "prelude",
		content: "think first",
		display: false,
		visibility: { until: "assistant_message" },
	});
	const assistantId = toolCallTurn(manager, "call-1", "file contents");
	manager.appendMessage(fauxAssistantMessage("done"));
	manager.appendMessage(user("next"));
	return { manager, preludeId, assistantId };
}

function roles(messages: { role: string }[]): string[] {
	return messages.map((message) => message.role);
}

function includeOnly(
	id: string,
	decision: { priority?: number; placement?: "tail" | "in_place" } = {},
): ProjectionFilter {
	return (entry) => (entry.sourceEntry.id === id ? { include: true, ...decision } : "default");
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

	it("moves canonical tail messages last", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("request"));
		manager.appendCustomMessageEntry({
			customType: "status",
			content: "open files",
			display: false,
			position: "tail",
		});
		manager.appendMessage(fauxAssistantMessage("answer"));
		const result = projectContext(manager.buildSessionProjection(), BUDGET);
		expect(roles(result.messages)).toEqual(["user", "assistant", "custom"]);
		expect(result.tokens).toBe(BUDGET.baselineTokens);
	});

	it("tells the filter which entries are omitted and what they cost", () => {
		const { manager, preludeId } = session();
		const seen = new Map<string, { omitted: boolean; tokens: number }>();
		projectContext(manager.buildSessionProjection(), BUDGET, (entry, info) => {
			seen.set(entry.sourceEntry.id, info);
			return "default";
		});
		expect(seen.get(preludeId)).toMatchObject({ omitted: true });
		expect(seen.get(preludeId)?.tokens).toBeGreaterThan(0);
		expect([...seen.values()].filter((info) => info.omitted)).toHaveLength(1);
	});

	it("never offers a superseded compaction summary as omitted", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendMessage(user("first"));
		manager.appendMessage(fauxAssistantMessage("answer"));
		manager.appendCompaction("OLD SUMMARY", firstId, 100);
		manager.appendMessage(user("second"));
		manager.appendCompaction("NEW SUMMARY", firstId, 100);
		const result = projectContext(manager.buildSessionProjection(), BUDGET, (_entry, info) =>
			info.omitted ? { include: true } : "default",
		);
		expect(JSON.stringify(result.messages)).not.toContain("OLD SUMMARY");
		expect(result.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("re-sends an omitted entry at the tail as a recall message by default", () => {
		const { manager, preludeId } = session();
		const result = projectContext(manager.buildSessionProjection(), BUDGET, includeOnly(preludeId));
		expect(roles(result.messages)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "custom"]);
		expect(result.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: CONTEXT_RECALL_TYPE,
			content: [{ type: "text", text: "think first" }],
			details: { entryId: preludeId },
		});
		expect(result.tokens).toBeGreaterThan(BUDGET.baselineTokens);
	});

	it("keeps a present entry in place unless asked to move it to the tail", () => {
		const { manager } = session();
		const projection = manager.buildSessionProjection();
		const firstUser = projection.entries[0].sourceEntry.id;
		const kept = projectContext(projection, BUDGET, includeOnly(firstUser));
		expect(kept.messages).toEqual(projection.messages);

		const moved = projectContext(projection, BUDGET, includeOnly(firstUser, { placement: "tail" }));
		expect(roles(moved.messages)).toEqual(["assistant", "toolResult", "assistant", "user", "custom"]);
		expect(moved.messages.at(-1)).toMatchObject({
			customType: CONTEXT_RECALL_TYPE,
			content: [{ type: "text", text: "request" }],
		});
		expect(moved.evicted).toEqual([]);
	});

	it("puts an omitted entry back in place when asked", () => {
		const { manager, preludeId } = session();
		const result = projectContext(
			manager.buildSessionProjection(),
			BUDGET,
			includeOnly(preludeId, { placement: "in_place" }),
		);
		expect(roles(result.messages)).toEqual(["user", "custom", "assistant", "toolResult", "assistant", "user"]);
		expect(result.messages[1]).toMatchObject({ role: "custom", customType: "prelude" });
	});

	it("drops tool results whose call was omitted or moved, and accounts for them", () => {
		const { manager, assistantId } = session();
		const projection = manager.buildSessionProjection();
		const omitted = projectContext(projection, BUDGET, (entry) =>
			entry.sourceEntry.id === assistantId ? "omit" : "default",
		);
		expect(roles(omitted.messages)).toEqual(["user", "assistant", "user"]);
		expect(omitted.tokens).toBeLessThan(BUDGET.baselineTokens);

		const moved = projectContext(projection, BUDGET, includeOnly(assistantId, { placement: "tail" }));
		expect(roles(moved.messages)).toEqual(["user", "assistant", "user"]);
		expect(moved.tokens).toBeLessThan(BUDGET.baselineTokens);
	});

	it("evicts additions lowest priority first, then oldest, to stay under the threshold", () => {
		const manager = SessionManager.inMemory();
		const note = (content: string) =>
			manager.appendCustomMessageEntry({
				customType: "note",
				content,
				display: false,
				visibility: { until: "assistant_message" },
			});
		const low = note("a".repeat(400));
		const high = note("b".repeat(400));
		const other = note("c".repeat(400));
		manager.appendMessage(fauxAssistantMessage("answer"));
		const projection = manager.buildSessionProjection();
		const priorities = new Map([
			[low, 0],
			[high, 1],
			[other, 1],
		]);
		const filter: ProjectionFilter = (entry) => {
			const priority = priorities.get(entry.sourceEntry.id);
			return priority === undefined ? "default" : { include: true, priority };
		};
		const cost = new Map<string, number>();
		projectContext(projection, BUDGET, (entry, info) => {
			cost.set(entry.sourceEntry.id, info.tokens);
			return filter(entry, info);
		});
		const total = (cost.get(low) ?? 0) + (cost.get(high) ?? 0) + (cost.get(other) ?? 0);
		const budget = (contextWindow: number) => ({ ...BUDGET, reserveTokens: 0, contextWindow });

		const fits = projectContext(projection, budget(BUDGET.baselineTokens + total), filter);
		expect(fits.evicted).toEqual([]);
		expect(roles(fits.messages)).toEqual(["assistant", "custom", "custom", "custom"]);

		const oneShort = projectContext(projection, budget(BUDGET.baselineTokens + total - 1), filter);
		expect(oneShort.evicted.map((item) => item.entry.sourceEntry.id)).toEqual([low]);
		expect(oneShort.tokens).toBe(BUDGET.baselineTokens + total - (cost.get(low) ?? 0));

		const twoShort = projectContext(
			projection,
			budget(BUDGET.baselineTokens + total - (cost.get(low) ?? 0) - 1),
			filter,
		);
		expect(twoShort.evicted.map((item) => item.entry.sourceEntry.id)).toEqual([low, high]);
		expect(roles(twoShort.messages)).toEqual(["assistant", "custom"]);
	});
});
