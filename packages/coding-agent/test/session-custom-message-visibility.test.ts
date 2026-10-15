import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateProjectedContextTokens, prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function label(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "custom":
			return `${message.role}:${typeof message.content === "string" ? message.content : ""}`;
		default:
			return message.role;
	}
}

function projected(session: SessionManager): string[] {
	return session.buildSessionProjection().messages.map(label);
}

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("custom message visibility", () => {
	it("keeps a message without visibility in context", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry({ customType: "note", content: "always", display: false });
		session.appendMessage(fauxAssistantMessage("reply"));
		session.appendMessage(user("next"));
		expect(projected(session)).toEqual(["custom:always", "assistant", "user:next"]);
	});

	it("drops an until-assistant_message entry once the model has answered", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("request"));
		const id = session.appendCustomMessageEntry({
			customType: "prelude",
			content: "think first",
			display: false,
			visibility: { until: "assistant_message" },
		});
		expect(projected(session)).toEqual(["user:request", "custom:think first"]);

		session.appendMessage(fauxAssistantMessage("answer"));
		expect(projected(session)).toEqual(["user:request", "assistant"]);
		const entry = session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id);
		expect(entry).toMatchObject({ sourceEntry: { type: "custom_message" }, messages: [] });
	});

	it("keeps an until-user_message entry through tool-call turns of the same run", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("request"));
		session.appendCustomMessageEntry({
			customType: "prelude",
			content: "plan",
			display: false,
			visibility: { until: "user_message" },
		});
		session.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		);
		session.appendMessage(toolResult("call-1", "output"));
		session.appendMessage(fauxAssistantMessage("done"));
		expect(projected(session)).toEqual(["user:request", "custom:plan", "assistant", "toolResult", "assistant"]);

		session.appendMessage(user("next"));
		expect(projected(session)).toEqual(["user:request", "assistant", "toolResult", "assistant", "user:next"]);
	});

	it("drops an until-compaction entry even when the compaction keeps it", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("request"));
		const keptId = session.appendCustomMessageEntry({
			customType: "scratch",
			content: "working notes",
			display: false,
			visibility: { until: "compaction" },
		});
		session.appendMessage(fauxAssistantMessage("answer"));
		expect(projected(session)).toEqual(["user:request", "custom:working notes", "assistant"]);

		session.appendCompaction("summary", keptId, 100);
		expect(projected(session)).toEqual(["compactionSummary", "assistant"]);
	});

	it("drops an until-assistantMessages entry after the n-th response", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry({
			customType: "nudge",
			content: "run the tests",
			display: false,
			visibility: { until: { assistantMessages: 2 } },
		});
		session.appendMessage(fauxAssistantMessage("first"));
		expect(projected(session)).toEqual(["custom:run the tests", "assistant"]);

		session.appendMessage(fauxAssistantMessage("second"));
		expect(projected(session)).toEqual(["assistant", "assistant"]);
	});

	it("drops an until-customType entry once a custom entry or message of that type follows", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry({
			customType: "plan",
			content: "the plan",
			display: false,
			visibility: { until: { customType: "flow.phase" } },
		});
		session.appendMessage(fauxAssistantMessage("working"));
		expect(projected(session)).toEqual(["custom:the plan", "assistant"]);

		session.appendCustomEntry("flow.phase", { phase: "implement" });
		expect(projected(session)).toEqual(["assistant"]);

		const second = SessionManager.inMemory();
		second.appendCustomMessageEntry({
			customType: "plan",
			content: "the plan",
			display: false,
			visibility: { until: { customType: "flow.phase" } },
		});
		second.appendCustomMessageEntry({ customType: "flow.phase", content: "next phase", display: false });
		expect(projected(second)).toEqual(["custom:next phase"]);
	});

	it("lets a later custom message with the same key supersede an earlier one", () => {
		const session = SessionManager.inMemory();
		const status = (content: string, key: string) =>
			session.appendCustomMessageEntry({ customType: "git", content, display: false, visibility: { key } });
		status("status: clean", "git-status");
		session.appendMessage(fauxAssistantMessage("edited a file"));
		status("status: dirty", "git-status");
		status("other key", "git-branch");
		expect(projected(session)).toEqual(["assistant", "custom:status: dirty", "custom:other key"]);
	});

	it("keeps one copy of a keyed message across a content edit", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry({
			customType: "git",
			content: "status: clean",
			display: false,
			visibility: { key: "git" },
		});
		session.appendContextEdit(id, { content: "status: clean (edited)" });
		session.appendMessage(fauxAssistantMessage("answer"));
		session.appendCustomMessageEntry({
			customType: "git",
			content: "status: dirty",
			display: false,
			visibility: { key: "git" },
		});
		expect(projected(session)).toEqual(["assistant", "custom:status: dirty"]);
	});

	it("evaluates expiry per branch", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(user("request"));
		const prelude = () =>
			session.appendCustomMessageEntry({
				customType: "prelude",
				content: "think",
				display: false,
				visibility: { until: "assistant_message" },
			});
		prelude();
		session.appendMessage(fauxAssistantMessage("answer"));

		session.branch(userId);
		prelude();
		expect(projected(session)).toEqual(["user:request", "custom:think"]);
	});

	it("persists visibility and position on the entry", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry({
			customType: "status",
			content: "open files",
			display: false,
			visibility: { until: "assistant_message" },
			position: "tail",
		});
		expect(session.getEntry(id)).toMatchObject({ visibility: { until: "assistant_message" }, position: "tail" });

		const plainId = session.appendCustomMessageEntry({ customType: "note", content: "always", display: false });
		expect(session.getEntry(plainId)).not.toHaveProperty("visibility");
		expect(session.getEntry(plainId)).not.toHaveProperty("position");
	});

	it("keeps entries in branch order and moves tail messages last in the session context", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("request"));
		const tailId = session.appendCustomMessageEntry({
			customType: "status",
			content: "open files",
			display: false,
			position: "tail",
		});
		session.appendMessage(fauxAssistantMessage("answer"));
		session.appendMessage(user("next"));

		const projection = session.buildSessionProjection();
		expect(projection.entries.map((entry) => entry.sourceEntry.id)[1]).toBe(tailId);
		expect(projection.messages.map(label)).toEqual(["user:request", "custom:open files", "assistant", "user:next"]);
		expect(session.buildSessionContext().messages.map(label)).toEqual([
			"user:request",
			"assistant",
			"user:next",
			"custom:open files",
		]);
	});

	it("counts a tail message once in the token estimate", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("request"));
		session.appendCustomMessageEntry({
			customType: "status",
			content: "x".repeat(4000),
			display: false,
			position: "tail",
		});
		const answer = fauxAssistantMessage("answer");
		session.appendMessage({ ...answer, usage: { ...answer.usage, input: 2000, totalTokens: 2001 } });

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.trailingTokens).toBe(0);
	});

	it("never cuts a compaction at a tail entry and keeps it after compacting", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("first"));
		const tailId = session.appendCustomMessageEntry({
			customType: "status",
			content: "TAIL STATE",
			display: false,
			position: "tail",
		});
		for (const turn of ["one", "two", "three"]) {
			session.appendMessage(fauxAssistantMessage(`${turn} `.repeat(100)));
			session.appendMessage(user(turn));
		}
		session.appendMessage(fauxAssistantMessage([fauxToolCall("read", {}, { id: "c1" })], { stopReason: "toolUse" }));
		session.appendMessage(toolResult("c1", "r1 ".repeat(100)));

		const preparation = prepareCompaction(session.getBranch(), {
			enabled: true,
			reserveTokens: 10,
			keepRecentTokens: 60,
		});
		expect(preparation).toBeDefined();
		expect(preparation?.firstKeptEntryId).not.toBe(tailId);
		expect(JSON.stringify(preparation?.messagesToSummarize)).toContain("TAIL STATE");

		session.appendCompaction("summary", preparation!.firstKeptEntryId, 100);
		expect(session.buildSessionProjection().messages.length).toBeLessThan(10);
	});

	it("restores the source content with a source edit", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry({ customType: "note", content: "original", display: false });
		session.appendContextEdit(id, { content: "replaced" });
		session.appendContextEdit(id, "source");
		expect(projected(session)).toEqual(["custom:original"]);

		const resultId = session.appendMessage(toolResult("call-1", "file contents"));
		session.appendContextEdit(resultId, null);
		expect(projected(session)).toEqual(["custom:original"]);
		session.appendContextEdit(resultId, "source");
		expect(projected(session)).toEqual(["custom:original", "toolResult"]);
	});

	it("gives an edit the target's visibility unless it carries its own", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry({
			customType: "prelude",
			content: "think first",
			display: false,
			visibility: { until: "assistant_message" },
		});
		session.appendContextEdit(id, { content: "edited" });
		session.appendMessage(fauxAssistantMessage("answer"));
		expect(projected(session)).toEqual(["assistant"]);

		// Restored after expiry: the inherited lifetime counts from the edit.
		session.appendContextEdit(id, "source");
		expect(projected(session)).toEqual(["custom:think first", "assistant"]);
		session.appendMessage(fauxAssistantMessage("second answer"));
		expect(projected(session)).toEqual(["assistant", "assistant"]);

		// A rebounded restore and a permanent one.
		session.appendContextEdit(id, "source", { until: { assistantMessages: 2 } });
		session.appendMessage(fauxAssistantMessage("third answer"));
		expect(projected(session)).toEqual(["custom:think first", "assistant", "assistant", "assistant"]);
		session.appendContextEdit(id, "source", {});
		session.appendMessage(fauxAssistantMessage("fourth answer"));
		session.appendMessage(fauxAssistantMessage("fifth answer"));
		expect(projected(session)[0]).toBe("custom:think first");

		session.appendContextEdit(id, null);
		expect(projected(session)[0]).toBe("assistant");
	});
});
