import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../src/core/compaction/compaction.ts";
import {
	CONTEXT_RECALL_TYPE,
	type ContextBudget,
	type ProjectedContext,
	type ProjectionEntryInfo,
	type ProjectionFilter,
	projectContext,
} from "../src/core/context-projection.ts";
import { fieldKey } from "../src/core/messages.ts";
import { SessionManager, type SessionProjection } from "../src/core/session-manager.ts";
import { toolResultMsg as toolResult, userMsg as user } from "./utilities.ts";

const BUDGET = { contextWindow: 100_000, reserveTokens: 10_000, baselineTokens: 1_000 };

/** A budget whose compaction threshold is exactly `threshold`. */
function tight(threshold: number): Omit<ContextBudget, "available"> {
	return { ...BUDGET, contextWindow: threshold, reserveTokens: 0 };
}

function toolCall(...ids: string[]): AssistantMessage {
	return fauxAssistantMessage(
		ids.map((id) => fauxToolCall("read", { path: "a.ts" }, { id })),
		{ stopReason: "toolUse" },
	);
}

function toolCallTurn(session: SessionManager, id: string, text: string): string {
	const assistantId = session.appendMessage(toolCall(id));
	session.appendMessage(toolResult(id, text));
	return assistantId;
}

function session(): { manager: SessionManager; userId: string; preludeId: string; assistantId: string } {
	const manager = SessionManager.inMemory();
	const userId = manager.appendMessage(user("request"));
	const preludeId = manager.appendCustomMessageEntry({
		customType: "prelude",
		content: "think first",
		display: false,
		visibility: { until: "assistant_message" },
	});
	const assistantId = toolCallTurn(manager, "call-1", "file contents");
	manager.appendMessage(fauxAssistantMessage("done"));
	manager.appendMessage(user("next"));
	return { manager, userId, preludeId, assistantId };
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

/** Estimated tokens of each entry's canonical messages, by entry id. */
function costs(projection: SessionProjection): (id: string) => number {
	const byId = new Map(
		projection.entries.map((entry) => [entry.sourceEntry.id, estimateMessagesTokens(entry.messages)]),
	);
	return (id) => byId.get(id) ?? 0;
}

function evictions(result: ProjectedContext): [string, "addition" | "canonical", number][] {
	return result.evicted.map((item) => [item.entry.sourceEntry.id, item.kind, item.tokens]);
}

/** Every path keeps `tokens` at the baseline plus the estimated difference to the canonical messages. */
function project(
	projection: SessionProjection,
	budget: Omit<ContextBudget, "available">,
	filter?: ProjectionFilter,
): ProjectedContext {
	const result = projectContext(projection, budget, filter);
	expect(result.tokens).toBe(
		budget.baselineTokens + estimateMessagesTokens(result.messages) - estimateMessagesTokens(projection.messages),
	);
	return result;
}

function infos(projection: SessionProjection): Map<string, ProjectionEntryInfo> {
	const seen = new Map<string, ProjectionEntryInfo>();
	project(projection, BUDGET, (entry, info) => {
		seen.set(entry.sourceEntry.id, info);
		return "default";
	});
	return seen;
}

describe("projectContext", () => {
	it("returns the canonical projection without a filter and reports the budget", () => {
		const { manager } = session();
		const projection = manager.buildSessionProjection();
		const result = project(projection, BUDGET);
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
		const result = project(manager.buildSessionProjection(), BUDGET);
		expect(roles(result.messages)).toEqual(["user", "assistant", "custom"]);
		expect(result.tokens).toBe(BUDGET.baselineTokens);
	});

	it("tells the filter why entries are omitted and what they cost", () => {
		const { manager, userId, preludeId } = session();
		manager.appendContextEdit(userId, null);
		const seen = infos(manager.buildSessionProjection());
		expect(seen.get(preludeId)?.omitted).toBe("expired");
		expect(seen.get(preludeId)?.tokens).toBeGreaterThan(0);
		expect(seen.get(userId)?.omitted).toBe("edit");
		expect([...seen.values()].filter((info) => info.omitted !== undefined)).toHaveLength(2);
	});

	it("reports a message superseded by a later one with its key", () => {
		const manager = SessionManager.inMemory();
		const status = (content: string) =>
			manager.appendCustomMessageEntry({
				customType: "status",
				content,
				display: false,
				visibility: { key: "status" },
			});
		const oldId = status("old");
		manager.appendMessage(fauxAssistantMessage("answer"));
		const newId = status("new");
		const seen = infos(manager.buildSessionProjection());
		expect(seen.get(oldId)?.omitted).toBe("superseded");
		expect(seen.get(newId)?.omitted).toBeUndefined();
	});

	it("tells the filter the annotations resolved for each entry", () => {
		const { manager, userId, preludeId } = session();
		const score = fieldKey("ext", "score", 1);
		const tag = fieldKey("ext", "tag", 1);
		manager.appendAnnotation(userId, { [score]: 3, [tag]: "draft" });
		manager.appendAnnotation(userId, { [tag]: null });
		const seen = infos(manager.buildSessionProjection());
		expect(seen.get(userId)?.annotations).toEqual({ [score]: 3 });
		expect(seen.get(preludeId)?.annotations).toEqual({});
	});

	it("never offers a superseded compaction summary as omitted", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendMessage(user("first"));
		manager.appendMessage(fauxAssistantMessage("answer"));
		manager.appendCompaction("OLD SUMMARY", firstId, 100);
		manager.appendMessage(user("second"));
		manager.appendCompaction("NEW SUMMARY", firstId, 100);
		const result = project(manager.buildSessionProjection(), BUDGET, (_entry, info) =>
			info.omitted ? { include: true } : "default",
		);
		expect(JSON.stringify(result.messages)).not.toContain("OLD SUMMARY");
		expect(result.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("re-sends an omitted entry at the tail as a recall message that refers to it", () => {
		const { manager, preludeId } = session();
		const result = project(manager.buildSessionProjection(), BUDGET, includeOnly(preludeId));
		expect(roles(result.messages)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "custom"]);
		expect(result.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: CONTEXT_RECALL_TYPE,
			content: [{ type: "text", text: "think first" }],
			ref: preludeId,
		});
		expect(result.messages.at(-1)).not.toHaveProperty("details");
		expect(result.tokens).toBeGreaterThan(BUDGET.baselineTokens);
	});

	it("keeps a present entry in place unless asked to move it to the tail", () => {
		const { manager, userId } = session();
		const projection = manager.buildSessionProjection();
		const kept = project(projection, BUDGET, includeOnly(userId));
		expect(kept.messages).toEqual(projection.messages);

		const moved = project(projection, BUDGET, includeOnly(userId, { placement: "tail" }));
		expect(roles(moved.messages)).toEqual(["assistant", "toolResult", "assistant", "user", "custom"]);
		expect(moved.messages.at(-1)).toMatchObject({
			customType: CONTEXT_RECALL_TYPE,
			content: [{ type: "text", text: "request" }],
			ref: userId,
		});
		expect(moved.evicted).toEqual([]);
	});

	it("keeps a present tail entry at the tail when included without a placement", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("request"));
		const statusId = manager.appendCustomMessageEntry({
			customType: "status",
			content: "open files",
			display: false,
			position: "tail",
		});
		manager.appendMessage(fauxAssistantMessage("answer"));
		const projection = manager.buildSessionProjection();

		const kept = project(projection, BUDGET, includeOnly(statusId));
		expect(roles(kept.messages)).toEqual(["user", "assistant", "custom"]);
		expect(kept.messages.at(-1)).toBe(projection.messages[1]);
		expect(kept.tokens).toBe(BUDGET.baselineTokens);

		// An explicit "in_place" moves it into its branch position.
		const moved = project(projection, BUDGET, includeOnly(statusId, { placement: "in_place" }));
		expect(roles(moved.messages)).toEqual(["user", "custom", "assistant"]);
		expect(moved.messages[1]).toBe(projection.messages[1]);
	});

	it("puts an omitted entry back in place when asked", () => {
		const { manager, preludeId } = session();
		const result = project(
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
		const omitted = project(projection, BUDGET, (entry) =>
			entry.sourceEntry.id === assistantId ? "omit" : "default",
		);
		expect(roles(omitted.messages)).toEqual(["user", "assistant", "user"]);
		expect(omitted.tokens).toBeLessThan(BUDGET.baselineTokens);

		const moved = project(projection, BUDGET, includeOnly(assistantId, { placement: "tail" }));
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
		project(projection, BUDGET, (entry, info) => {
			cost.set(entry.sourceEntry.id, info.tokens);
			return filter(entry, info);
		});
		const total = (cost.get(low) ?? 0) + (cost.get(high) ?? 0) + (cost.get(other) ?? 0);

		const fits = project(projection, tight(BUDGET.baselineTokens + total), filter);
		expect(fits.evicted).toEqual([]);
		expect(roles(fits.messages)).toEqual(["assistant", "custom", "custom", "custom"]);

		const oneShort = project(projection, tight(BUDGET.baselineTokens + total - 1), filter);
		expect(evictions(oneShort)).toEqual([[low, "addition", cost.get(low)]]);
		expect(oneShort.tokens).toBe(BUDGET.baselineTokens + total - (cost.get(low) ?? 0));

		const twoShort = project(projection, tight(BUDGET.baselineTokens + total - (cost.get(low) ?? 0) - 1), filter);
		expect(twoShort.evicted.map((item) => item.entry.sourceEntry.id)).toEqual([low, high]);
		expect(roles(twoShort.messages)).toEqual(["assistant", "custom"]);
	});
});

describe("projectContext tool-call groups", () => {
	it("moves a custom message recorded inside a tool-call group after its results", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("request"));
		manager.appendMessage(toolCall("call-1"));
		manager.appendCustomMessageEntry({ customType: "note", content: "inside", display: false });
		manager.appendMessage(toolResult("call-1", "file contents"));
		manager.appendMessage(fauxAssistantMessage("done"));
		const projection = manager.buildSessionProjection();
		expect(roles(projection.messages)).toEqual(["user", "assistant", "custom", "toolResult", "assistant"]);

		const result = project(projection, BUDGET);
		expect(roles(result.messages)).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
		expect(result.messages[3]).toBe(projection.messages[2]);
		expect(result.tokens).toBe(BUDGET.baselineTokens);
		expect(result.evicted).toEqual([]);
	});

	it("keeps every result of a group before the message that interrupted it", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(toolCall("call-1", "call-2"));
		manager.appendMessage(toolResult("call-1", "first"));
		manager.appendCustomMessageEntry({ customType: "note", content: "inside", display: false });
		manager.appendMessage(toolResult("call-2", "second"));
		const result = project(manager.buildSessionProjection(), BUDGET);
		expect(roles(result.messages)).toEqual(["assistant", "toolResult", "toolResult", "custom"]);
		expect(result.messages.map((message) => (message.role === "toolResult" ? message.toolCallId : ""))).toEqual([
			"",
			"call-1",
			"call-2",
			"",
		]);
		expect(result.tokens).toBe(BUDGET.baselineTokens);
	});

	it("flushes a deferred message before the assistant message that follows an unanswered call", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(toolCall("call-1"));
		manager.appendCustomMessageEntry({ customType: "note", content: "inside", display: false });
		const resultId = manager.appendMessage(toolResult("call-1", "file contents"));
		manager.appendMessage(fauxAssistantMessage("done"));
		const projection = manager.buildSessionProjection();
		const result = project(projection, BUDGET, (entry) => (entry.sourceEntry.id === resultId ? "omit" : "default"));
		expect(roles(result.messages)).toEqual(["assistant", "custom", "assistant"]);
		expect(result.tokens).toBe(
			BUDGET.baselineTokens - estimateMessagesTokens([toolResult("call-1", "file contents")]),
		);
	});

	it("still closes a group at a user message, so a result after it is dropped", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(toolCall("call-1"));
		manager.appendMessage(user("interrupt"));
		manager.appendMessage(toolResult("call-1", "file contents"));
		const projection = manager.buildSessionProjection();
		const result = project(projection, BUDGET);
		expect(roles(result.messages)).toEqual(["assistant", "user"]);
		expect(result.tokens).toBe(BUDGET.baselineTokens - costs(projection)(manager.getBranch()[2].id));
	});
});

describe("projectContext canonical eviction", () => {
	function notes(): { projection: SessionProjection; low: string; high: string; other: string; plain: string } {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("request"));
		const note = (content: string, priority?: number) =>
			manager.appendCustomMessageEntry({
				customType: "note",
				content,
				display: false,
				...(priority === undefined ? {} : { priority }),
			});
		const low = note("a".repeat(400), 0);
		const high = note("b".repeat(400), 1);
		const other = note("c".repeat(400), 1);
		const plain = note("d".repeat(400));
		manager.appendMessage(fauxAssistantMessage("answer"));
		return { projection: manager.buildSessionProjection(), low, high, other, plain };
	}

	it("evicts content with a declared priority, lowest first then oldest, never undeclared content", () => {
		const { projection, low, high, other, plain } = notes();
		const cost = costs(projection);
		const baseline = BUDGET.baselineTokens;

		const fits = project(projection, tight(baseline));
		expect(fits.evicted).toEqual([]);
		expect(fits.messages).toEqual(projection.messages);

		const oneOver = project(projection, tight(baseline - 1));
		expect(evictions(oneOver)).toEqual([[low, "canonical", cost(low)]]);
		expect(roles(oneOver.messages)).toEqual(["user", "custom", "custom", "custom", "assistant"]);
		expect(JSON.stringify(oneOver.messages)).not.toContain("a".repeat(400));
		expect(oneOver.tokens).toBe(baseline - cost(low));

		const twoOver = project(projection, tight(baseline - cost(low) - 1));
		expect(evictions(twoOver).map(([id]) => id)).toEqual([low, high]);
		expect(twoOver.tokens).toBe(baseline - cost(low) - cost(high));

		// A window of zero means unknown and never evicts; one token is the tightest real threshold.
		const everything = project(projection, tight(1));
		expect(evictions(everything).map(([id]) => id)).toEqual([low, high, other]);
		expect(roles(everything.messages)).toEqual(["user", "custom", "assistant"]);
		expect(everything.messages[1]).toBe(
			projection.entries.find((entry) => entry.sourceEntry.id === plain)?.messages[0],
		);
		expect(everything.tokens).toBe(baseline - cost(low) - cost(high) - cost(other));
	});

	it("never evicts for a model without a known context window", () => {
		const { projection } = notes();
		const result = project(projection, { contextWindow: 0, reserveTokens: 10_000, baselineTokens: 100 });
		expect(result.evicted).toEqual([]);
		expect(result.messages).toEqual(projection.messages);
		expect(result.budget.available).toBe(-10_100);
	});

	it("evicts additions before canonical content, whatever their priorities", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("request"));
		const preludeId = manager.appendCustomMessageEntry({
			customType: "prelude",
			content: "p".repeat(400),
			display: false,
			visibility: { until: "assistant_message" },
		});
		const noteId = manager.appendCustomMessageEntry({
			customType: "note",
			content: "n".repeat(400),
			display: false,
			priority: 0,
		});
		manager.appendMessage(fauxAssistantMessage("answer"));
		const projection = manager.buildSessionProjection();
		const cost = costs(projection);
		const baseline = BUDGET.baselineTokens;
		const filter = includeOnly(preludeId, { priority: 5 });
		const recall = project(projection, BUDGET, filter).tokens - baseline;
		expect(recall).toBeGreaterThan(0);

		const fits = project(projection, tight(baseline + recall), filter);
		expect(fits.evicted).toEqual([]);
		expect(roles(fits.messages)).toEqual(["user", "custom", "assistant", "custom"]);

		const oneOver = project(projection, tight(baseline + recall - 1), filter);
		expect(evictions(oneOver)).toEqual([[preludeId, "addition", recall]]);
		expect(roles(oneOver.messages)).toEqual(["user", "custom", "assistant"]);
		expect(oneOver.tokens).toBe(baseline);

		const twoOver = project(projection, tight(baseline - 1), filter);
		expect(evictions(twoOver)).toEqual([
			[preludeId, "addition", recall],
			[noteId, "canonical", cost(noteId)],
		]);
		expect(roles(twoOver.messages)).toEqual(["user", "assistant"]);
		expect(twoOver.tokens).toBe(baseline - cost(noteId));
	});

	it("evicts an edited entry under the edit's priority and drops its orphaned tool results", () => {
		const { manager, assistantId } = session();
		manager.appendContextEdit(assistantId, "source", { priority: 0 });
		const projection = manager.buildSessionProjection();
		const cost = costs(projection);
		const resultId =
			manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult")?.id ?? "";

		const result = project(projection, tight(BUDGET.baselineTokens - 1));
		expect(roles(result.messages)).toEqual(["user", "assistant", "user"]);
		expect(evictions(result)).toEqual([[assistantId, "canonical", cost(assistantId)]]);
		expect(result.tokens).toBe(BUDGET.baselineTokens - cost(assistantId) - cost(resultId));
	});

	it("evicts tail content under the entry's declared priority, not the filter's", () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("request"));
		const statusId = manager.appendCustomMessageEntry({
			customType: "status",
			content: "open files",
			display: false,
			position: "tail",
			priority: 0,
		});
		manager.appendMessage(fauxAssistantMessage("answer"));
		const projection = manager.buildSessionProjection();
		const cost = costs(projection);
		const threshold = tight(BUDGET.baselineTokens - 1);

		const canonical = project(projection, threshold);
		expect(roles(canonical.messages)).toEqual(["user", "assistant"]);
		expect(evictions(canonical)).toEqual([[statusId, "canonical", cost(statusId)]]);
		expect(canonical.tokens).toBe(BUDGET.baselineTokens - cost(statusId));

		// A present entry re-sent at the tail keeps its own priority; the recall costs the same as its content.
		const resent = project(projection, threshold, includeOnly(statusId, { placement: "tail", priority: 9 }));
		expect(roles(resent.messages)).toEqual(["user", "assistant"]);
		expect(evictions(resent)).toEqual([[statusId, "canonical", cost(statusId)]]);
		expect(resent.tokens).toBe(BUDGET.baselineTokens - cost(statusId));

		// A re-sent entry without a declared priority is never evicted, whatever the filter says.
		const undeclared = project(projection, threshold, includeOnly(userId, { placement: "tail", priority: 0 }));
		expect(roles(undeclared.messages)).toEqual(["assistant", "custom"]);
		expect(undeclared.messages.at(-1)).toMatchObject({ customType: CONTEXT_RECALL_TYPE, ref: userId });
		expect(evictions(undeclared)).toEqual([[statusId, "canonical", cost(statusId)]]);
		expect(undeclared.tokens).toBe(BUDGET.baselineTokens - cost(statusId));
	});
});
