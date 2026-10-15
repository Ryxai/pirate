import { type AssistantMessage, fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateProjectedContextTokens,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import { fieldKey } from "../src/core/messages.ts";
import { type FileEntry, SessionManager } from "../src/core/session-manager.ts";

function text(message: { content: string | Array<{ type: string; text?: string }> }): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

describe("session context edits", () => {
	it("omits a target only from model projection", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const assistantId = session.appendMessage(fauxAssistantMessage("partial"));
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "raw output" }],
			details: { path: "large.txt" },
			isError: true,
			timestamp: Date.now(),
		};
		const resultId = session.appendMessage(result);
		session.appendContextEdit(assistantId, null);
		session.appendContextEdit(resultId, null);

		expect(session.getBranch().filter((entry) => entry.type === "message")).toHaveLength(3);
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual(["user"]);
		expect((session.getEntry(resultId) as { message: ToolResultMessage }).message).toBe(result);
	});

	it("replaces only content and lets the latest edit win", () => {
		const session = SessionManager.inMemory();
		const original = fauxAssistantMessage("original");
		original.usage = { ...original.usage, totalTokens: 11 };
		const targetId = session.appendMessage(original);
		session.appendContextEdit(targetId, { content: [{ type: "text", text: "first" }] });
		session.appendContextEdit(targetId, null);
		session.appendContextEdit(targetId, { content: [{ type: "text", text: "restored" }] });

		const projected = session.buildSessionProjection().messages[0];
		expect(projected.role).toBe("assistant");
		if (projected.role !== "assistant") throw new Error("expected assistant");
		expect(text(projected)).toBe("restored");
		expect(projected.usage.totalTokens).toBe(11);
		expect(text((session.getEntry(targetId) as { message: AssistantMessage }).message)).toBe("original");
	});

	it("normalizes string replacements for array-only assistant and tool-result roles", () => {
		const session = SessionManager.inMemory();
		const assistantId = session.appendMessage(fauxAssistantMessage("original"));
		const resultId = session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "original result" }],
			isError: false,
			timestamp: Date.now(),
		});
		const assistantEditId = session.appendContextEdit(assistantId, { content: "assistant replacement" });
		const resultEditId = session.appendContextEdit(resultId, { content: "result replacement" });

		expect(session.getEntry(assistantEditId)).toMatchObject({
			replacement: { content: [{ type: "text", text: "assistant replacement" }] },
		});
		expect(session.getEntry(resultEditId)).toMatchObject({
			replacement: { content: [{ type: "text", text: "result replacement" }] },
		});
		const projected = session.buildSessionProjection().messages;
		expect(projected[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "assistant replacement" }],
		});
		expect(projected[1]).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "result replacement" }],
		});
	});

	it("normalizes imported string replacements while projecting array-only roles", () => {
		const session = SessionManager.inMemory();
		const assistantId = session.appendMessage(fauxAssistantMessage("original"));
		const editId = session.appendContextEdit(assistantId, null);
		const edit = session.getEntry(editId);
		if (edit?.type !== "context_edit") throw new Error("expected context edit");
		edit.replacement = { content: "imported replacement" };

		expect(session.buildSessionProjection().messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "imported replacement" }],
		});
	});

	it("keeps edits branch-relative", () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		session.appendContextEdit(targetId, { content: "edited" });
		expect(text(session.buildSessionProjection().messages[0] as { content: string })).toBe("edited");

		session.branch(targetId);
		expect(text(session.buildSessionProjection().messages[0] as { content: string })).toBe("original");
	});

	it("uses a self-referencing compaction to retain no preceding entries", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "discarded", timestamp: Date.now() });
		const compactionId = session.appendCompaction("exact handoff", null, 100);
		session.appendMessage({ role: "user", content: "after", timestamp: Date.now() });

		const compaction = session.getEntry(compactionId);
		expect(compaction).toMatchObject({ type: "compaction", firstKeptEntryId: compactionId });
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
		]);
		expect(
			session
				.buildSessionProjection()
				.messages.map((message) => ("summary" in message ? message.summary : text(message as { content: string }))),
		).toEqual(["exact handoff", "after"]);
	});

	it("applies post-compaction edits to retained pre-compaction entries", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "summarized", timestamp: Date.now() });
		const retainedId = session.appendMessage({ role: "user", content: "original retained", timestamp: Date.now() });
		session.appendCompaction("summary", retainedId, 100);
		session.appendContextEdit(retainedId, { content: "edited retained" });

		expect(
			session
				.buildSessionProjection()
				.messages.map((message) => ("summary" in message ? message.summary : text(message as { content: string }))),
		).toEqual(["summary", "edited retained"]);
	});

	it("uses only the newest summary when a repeated compaction retains entries before the older compaction", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "summarized first", timestamp: Date.now() });
		const retainedId = session.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
		session.appendCompaction("first summary", retainedId, 100);
		session.appendMessage(fauxAssistantMessage("after first compaction"));
		session.appendCompaction("second summary", retainedId, 80);
		session.appendMessage({ role: "user", content: "new tail ".repeat(100), timestamp: Date.now() });

		const summaries = session
			.buildSessionProjection()
			.messages.flatMap((message) => ("summary" in message ? [message.summary] : []));
		expect(summaries).toEqual(["second summary"]);
		// The older summary is stale, not omitted: it gets no reason.
		const compactions = session
			.buildSessionProjection()
			.entries.filter((entry) => entry.sourceEntry.type === "compaction");
		expect(compactions.map((entry) => entry.messages.length > 0)).toEqual([true, false]);
		expect(compactions[1]).not.toHaveProperty("omitted");
		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.previousSummary).toBe("second summary");
	});

	it("supports repeated retain-none compactions", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "discarded", timestamp: Date.now() });
		session.appendCompaction("first handoff", null, 100);
		session.appendMessage({ role: "user", content: "also discarded", timestamp: Date.now() });
		const secondId = session.appendCompaction("second handoff", null, 50);

		expect(session.getEntry(secondId)).toMatchObject({ firstKeptEntryId: secondId });
		expect(
			session.buildSessionProjection().messages.map((message) => ("summary" in message ? message.summary : "")),
		).toEqual(["second handoff"]);
	});

	it("does not trust pre-edit assistant usage for projected context estimates", () => {
		const session = SessionManager.inMemory();
		const largeUserId = session.appendMessage({
			role: "user",
			content: "discarded input ".repeat(2_000),
			timestamp: Date.now(),
		});
		const response = fauxAssistantMessage("small answer");
		response.usage = { ...response.usage, input: 10_000, totalTokens: 10_001 };
		const assistantId = session.appendMessage(response);
		session.appendContextEdit(largeUserId, null);

		const editedEstimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(editedEstimate.usageTokens).toBe(0);
		expect(editedEstimate.tokens).toBeLessThan(100);

		session.appendContextEdit(assistantId, null);
		expect(estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens).toBe(0);
	});

	it("uses assistant usage captured after the latest context edit", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		session.appendContextEdit(userId, { content: "edited" });
		const response = fauxAssistantMessage("answer");
		response.usage = { ...response.usage, input: 4_000, output: 100, totalTokens: 4_100 };
		session.appendMessage(response);
		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.usageTokens).toBe(4_100);
		expect(estimate.trailingTokens).toBe(1);
		expect(estimate.tokens).toBe(4_101);
	});

	it("does not reuse post-edit assistant usage after a later compaction", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({ role: "user", content: "small input", timestamp: Date.now() });
		session.appendContextEdit(userId, { content: "edited input" });
		const response = fauxAssistantMessage("answer");
		response.usage = { ...response.usage, input: 50_000, output: 1, totalTokens: 50_001 };
		session.appendMessage(response);
		session.appendCompaction("small summary", userId, 50_001);

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBeLessThan(100);
	});

	it("includes effective system and tool context in edited estimates", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "system",
			content: "system prompt ".repeat(3_000),
			toolsAdded: [
				{
					name: "example",
					description: "tool declaration ".repeat(100),
					parameters: { type: "object", properties: {} },
				},
			],
			timestamp: Date.now(),
		});
		const userId = session.appendMessage({ role: "user", content: "ask", timestamp: Date.now() });
		session.appendMessage(fauxAssistantMessage("done"));
		session.appendContextEdit(userId, { content: "ask" });

		expect(
			estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens,
		).toBeGreaterThan(10_000);
	});

	it("does not advance past a boundary replacement of the candidate input", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
		session.appendMessage(fauxAssistantMessage("old answer"));
		const replacedUserId = session.appendMessage({
			role: "user",
			content: "original input",
			timestamp: Date.now(),
		});
		const assistantId = session.appendMessage(fauxAssistantMessage("answered original input"));
		session.appendContextEdit(replacedUserId, { content: "NEW-INSTRUCTION ".repeat(100) });
		session.appendContextEdit(assistantId, null);
		session.appendCustomEntry("bookkeeping", { source: "test" });

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(replacedUserId);
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("NEW-INSTRUCTION");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("NEW-INSTRUCTION");
	});

	it("does not let metadata move the cut past unsent boundary input", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
		session.appendMessage(fauxAssistantMessage("old answer"));
		const instructionId = session.appendCustomMessageEntry({
			customType: "next-work",
			content: "UNSENT-INSTRUCTION ".repeat(100),
			display: false,
		});
		session.appendCustomEntry("bookkeeping", { source: "test" });

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(instructionId);
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("UNSENT-INSTRUCTION");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("UNSENT-INSTRUCTION");
	});

	it("does not treat an omitted custom message as a recovery attempt", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "user",
			content: "unanswered input ".repeat(100),
			timestamp: Date.now(),
		});
		const customId = session.appendCustomMessageEntry({
			customType: "temporary",
			content: "temporary context",
			display: false,
		});
		session.appendContextEdit(customId, null);

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation).toBeUndefined();
	});

	it("advances past input for an omitted assistant recovery suffix with metadata", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({
			role: "user",
			content: "recovery input ".repeat(100),
			timestamp: Date.now(),
		});
		const attemptId = session.appendMessage(fauxAssistantMessage("failed attempt"));
		session.appendContextEdit(attemptId, null);
		session.appendCustomEntry("bookkeeping", { source: "test" });

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(attemptId);
		expect(preparation?.turnPrefixMessages).toEqual([
			expect.objectContaining({ role: "user", content: expect.stringContaining("recovery input") }),
		]);
		expect(preparation?.messagesToSummarize).not.toContainEqual(
			expect.objectContaining({ role: "user", content: expect.stringContaining("recovery input") }),
		);
		expect(userId).not.toBe(attemptId);
	});

	it("prepares compaction from edited model content", () => {
		const session = SessionManager.inMemory();
		const omittedId = session.appendMessage({ role: "user", content: "OMIT-ME ".repeat(100), timestamp: Date.now() });
		session.appendMessage(fauxAssistantMessage("old answer ".repeat(100)));
		session.appendContextEdit(omittedId, null);
		session.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
		session.appendMessage(fauxAssistantMessage("suffix"));

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation).toBeDefined();
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("OMIT-ME");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("OMIT-ME");
	});

	it("reports a null edit as the omission reason", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const assistantId = session.appendMessage(fauxAssistantMessage("answer"));
		session.appendContextEdit(assistantId, null);
		session.appendCustomEntry("bookkeeping", { source: "test" });
		const find = (id: string) =>
			session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id);

		expect(find(assistantId)).toMatchObject({ omitted: "edit", messages: [] });
		expect(find(userId)).not.toHaveProperty("omitted");
		expect(session.buildSessionProjection().entries.filter((entry) => entry.omitted)).toHaveLength(1);

		session.appendContextEdit(assistantId, { content: "replaced" });
		expect(find(assistantId)).not.toHaveProperty("omitted");
		session.appendContextEdit(assistantId, "source");
		expect(find(assistantId)).not.toHaveProperty("omitted");
	});

	it("keeps a null edit as the reason once the lifetime the target had ends", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const preludeId = session.appendCustomMessageEntry({
			customType: "prelude",
			content: "think first",
			display: false,
			visibility: { until: "assistant_message" },
		});
		const statusId = session.appendCustomMessageEntry({
			customType: "status",
			content: "status: clean",
			display: false,
			visibility: { key: "status" },
		});
		session.appendContextEdit(preludeId, null);
		session.appendContextEdit(statusId, null);
		const find = (id: string) =>
			session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id);
		expect(find(preludeId)).toMatchObject({ omitted: "edit", messages: [] });
		expect(find(statusId)).toMatchObject({ omitted: "edit", messages: [] });

		// The entries that would have expired or superseded the targets: the null edits stay the reason.
		session.appendMessage(fauxAssistantMessage("answer"));
		session.appendCustomMessageEntry({
			customType: "status",
			content: "status: dirty",
			display: false,
			visibility: { key: "status" },
		});
		expect(find(preludeId)).toMatchObject({ omitted: "edit", messages: [] });
		expect(find(statusId)).toMatchObject({ omitted: "edit", messages: [] });
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
		]);
	});

	it("resolves priority from the latest edit, else the entry's own", () => {
		const session = SessionManager.inMemory();
		const noteId = session.appendCustomMessageEntry({
			customType: "note",
			content: "n",
			display: false,
			priority: 5,
		});
		const userId = session.appendMessage({ role: "user", content: "ask", timestamp: Date.now() });
		const find = (id: string) =>
			session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id);
		expect(session.getEntry(noteId)).toMatchObject({ priority: 5 });
		expect(find(noteId)).toMatchObject({ priority: 5 });
		expect(find(userId)).not.toHaveProperty("priority");

		const editId = session.appendContextEdit(noteId, "source", { priority: 0 });
		session.appendContextEdit(userId, { content: "ask (edited)" }, { priority: 3 });
		expect(session.getEntry(editId)).toMatchObject({ priority: 0 });
		expect(session.getEntry(editId)).not.toHaveProperty("visibility");
		expect(find(noteId)).toMatchObject({ priority: 0 });
		expect(find(userId)).toMatchObject({ priority: 3 });

		session.appendContextEdit(noteId, "source");
		session.appendContextEdit(userId, "source");
		expect(find(noteId)).toMatchObject({ priority: 5 });
		expect(find(userId)).not.toHaveProperty("priority");
	});
});

describe("annotations", () => {
	const status = fieldKey("review", "status", 1);
	const note = fieldKey("review", "note", 1);

	it("resolves the latest value per key and clears on null", () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		expect(session.getAnnotations(targetId)).toEqual({});

		const id = session.appendAnnotation(targetId, { [status]: "pending", [note]: "look again" });
		expect(session.getEntry(id)).toMatchObject({
			type: "annotation",
			targetId,
			fields: { [status]: "pending", [note]: "look again" },
		});
		session.appendMessage(fauxAssistantMessage("answer"));
		session.appendAnnotation(targetId, { [status]: "done" });
		expect(session.getAnnotations(targetId)).toEqual({ [status]: "done", [note]: "look again" });
		expect(session.buildSessionProjection().annotations).toEqual(
			new Map([[targetId, { [status]: "done", [note]: "look again" }]]),
		);

		session.appendAnnotation(targetId, { [note]: null });
		expect(session.getAnnotations(targetId)).toEqual({ [status]: "done" });
		session.appendAnnotation(targetId, { [status]: null });
		expect(session.getAnnotations(targetId)).toEqual({});
		expect(session.buildSessionProjection().annotations.has(targetId)).toBe(false);
	});

	it("keeps annotations branch-local", () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const forkId = session.appendMessage(fauxAssistantMessage("answer"));
		session.appendAnnotation(targetId, { [status]: "done" });
		expect(session.getAnnotations(targetId)).toEqual({ [status]: "done" });

		session.branch(forkId);
		expect(session.getAnnotations(targetId)).toEqual({});
		session.appendAnnotation(targetId, { [note]: "other branch" });
		expect(session.getAnnotations(targetId)).toEqual({ [note]: "other branch" });
		expect(session.buildSessionProjection().annotations.get(targetId)).toEqual({ [note]: "other branch" });
	});

	it("survives a compaction cut", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "summarized", timestamp: Date.now() });
		const targetId = session.appendCustomMessageEntry({ customType: "note", content: "retained", display: false });
		session.appendAnnotation(targetId, { [status]: "done" });
		session.appendMessage(fauxAssistantMessage("answer"));
		const keptId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });

		// Retained target: the annotation sits inside the kept range.
		session.appendCompaction("summary", targetId, 100);
		expect(session.getAnnotations(targetId)).toEqual({ [status]: "done" });
		expect(session.buildSessionProjection().annotations.get(targetId)).toEqual({ [status]: "done" });

		// Target and annotation older than the cut: still resolved over the branch.
		session.appendCompaction("later summary", keptId, 100);
		expect(session.buildContextEntries().some((entry) => entry.id === targetId)).toBe(false);
		expect(session.getAnnotations(targetId)).toEqual({ [status]: "done" });
		expect(session.buildSessionProjection().annotations.get(targetId)).toEqual({ [status]: "done" });
	});

	it("rejects a target that is missing or off the active branch", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const abandonedId = session.appendMessage(fauxAssistantMessage("answer"));
		session.branch(rootId);
		expect(() => session.appendAnnotation("missing", { [status]: "done" })).toThrow("Entry missing not found");
		expect(() => session.appendAnnotation(abandonedId, { [status]: "done" })).toThrow(
			`Entry ${abandonedId} is not on the active branch`,
		);
		expect(session.getEntries()).toHaveLength(2);
	});

	it("projects hand-built annotations and edits with malformed targets, fields, and priorities", () => {
		const timestamp = new Date().toISOString();
		const annotation = { type: "annotation", timestamp };
		const entries = [
			{ type: "session", version: 3, id: "s", timestamp, cwd: "/" },
			{
				type: "message",
				id: "u",
				parentId: null,
				timestamp,
				message: { role: "user", content: "ask", timestamp: 1 },
			},
			{ ...annotation, id: "a1", parentId: "u", targetId: 42, fields: { [status]: "done" } },
			{ ...annotation, id: "a2", parentId: "a1", targetId: "u", fields: "nope" },
			{ ...annotation, id: "a3", parentId: "a2", targetId: "u", fields: [status] },
			{ ...annotation, id: "a4", parentId: "a3", targetId: "u", fields: { [status]: "done" } },
			{ ...annotation, id: "a5", parentId: "a4", targetId: "ghost", fields: { [status]: "dangling" } },
			{ type: "context_edit", id: "e1", parentId: "a5", timestamp, targetId: "ghost", replacement: null },
			{
				type: "context_edit",
				id: "e2",
				parentId: "e1",
				timestamp,
				targetId: "u",
				replacement: "source",
				priority: "high",
			},
		] as unknown as FileEntry[];
		const session = SessionManager.inMemory(process.cwd(), undefined, entries);

		const projection = session.buildSessionProjection();
		expect(projection.messages.map((message) => message.role)).toEqual(["user"]);
		expect(projection.entries[0]).not.toHaveProperty("priority");
		expect(projection.annotations.get("u")).toEqual({ [status]: "done" });
		expect(session.getAnnotations("u")).toEqual({ [status]: "done" });
		expect(session.getAnnotations("ghost")).toEqual({ [status]: "dangling" });
	});
});
