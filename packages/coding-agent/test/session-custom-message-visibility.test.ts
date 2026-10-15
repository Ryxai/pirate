import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function getCustomText(message: { role: string; content?: unknown }): string {
	if (message.role !== "custom") return "";
	return typeof message.content === "string" ? message.content : "";
}

function projectedRoles(session: SessionManager): string[] {
	return session.buildSessionProjection().messages.map((message) => message.role);
}

describe("custom message visibility", () => {
	it("keeps a message without visibility in context", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry("note", "always", false);
		session.appendMessage(assistant("reply"));
		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		expect(projectedRoles(session)).toEqual(["custom", "assistant", "user"]);
	});

	it("drops an until-assistant_message entry once the model has answered", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const id = session.appendCustomMessageEntry("prelude", "think first", false, undefined, {
			until: "assistant_message",
		});

		expect(projectedRoles(session)).toEqual(["user", "custom"]);
		expect(
			session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id)?.messages,
		).toHaveLength(1);

		session.appendMessage(assistant("answer"));

		expect(projectedRoles(session)).toEqual(["user", "assistant"]);
		const projected = session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id);
		expect(projected?.sourceEntry.type).toBe("custom_message");
		expect(projected?.messages).toEqual([]);
	});

	it("keeps an until-user_message entry through tool-call turns of the same run", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		session.appendCustomMessageEntry("prelude", "plan", false, undefined, { until: "user_message" });
		session.appendMessage(assistant("calling a tool"));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "output" }],
			isError: false,
			timestamp: Date.now(),
		});
		session.appendMessage(assistant("done"));

		expect(projectedRoles(session)).toEqual(["user", "custom", "assistant", "toolResult", "assistant"]);

		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		expect(projectedRoles(session)).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
	});

	it("drops an until-compaction entry even when the compaction keeps it", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const keptId = session.appendCustomMessageEntry("scratch", "working notes", false, undefined, {
			until: "compaction",
		});
		session.appendMessage(assistant("answer"));

		expect(projectedRoles(session)).toEqual(["user", "custom", "assistant"]);

		session.appendCompaction("summary", keptId, 100);

		expect(projectedRoles(session)).toEqual(["compactionSummary", "assistant"]);
	});

	it("evaluates expiry per branch", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		session.appendCustomMessageEntry("prelude", "think first", false, undefined, { until: "assistant_message" });
		session.appendMessage(assistant("answer"));

		session.branch(userId);
		session.appendCustomMessageEntry("prelude", "think again", false, undefined, { until: "assistant_message" });

		expect(projectedRoles(session)).toEqual(["user", "custom"]);
	});

	it("persists visibility on the entry", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry("prelude", "think", false, undefined, { until: "assistant_message" });
		expect(session.getEntry(id)).toMatchObject({
			type: "custom_message",
			visibility: { until: "assistant_message" },
		});

		const plainId = session.appendCustomMessageEntry("note", "always", false);
		expect(session.getEntry(plainId)).not.toHaveProperty("visibility");
	});

	it("drops an until-assistantMessages entry after the n-th response", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry("nudge", "run the tests", false, undefined, {
			until: { assistantMessages: 2 },
		});
		session.appendMessage(assistant("first"));
		expect(projectedRoles(session)).toEqual(["custom", "assistant"]);

		session.appendMessage(assistant("second"));
		expect(projectedRoles(session)).toEqual(["assistant", "assistant"]);
	});

	it("drops an until-customType entry once a custom entry or message of that type follows", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry("plan", "the plan", false, undefined, { until: { customType: "flow.phase" } });
		session.appendMessage(assistant("working"));
		expect(projectedRoles(session)).toEqual(["custom", "assistant"]);

		session.appendCustomEntry("flow.phase", { phase: "implement" });
		expect(projectedRoles(session)).toEqual(["assistant"]);

		const second = SessionManager.inMemory();
		second.appendCustomMessageEntry("plan", "the plan", false, undefined, { until: { customType: "flow.phase" } });
		second.appendCustomMessageEntry("flow.phase", "next phase", false);
		expect(second.buildSessionProjection().messages.map((message) => getCustomText(message))).toEqual(["next phase"]);
	});

	it("lets a later custom message with the same key supersede an earlier one", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry("git", "status: clean", false, undefined, { key: "git-status" });
		session.appendMessage(assistant("edited a file"));
		session.appendCustomMessageEntry("git", "status: dirty", false, undefined, { key: "git-status" });
		session.appendCustomMessageEntry("git", "other key", false, undefined, { key: "git-branch" });

		expect(session.buildSessionProjection().messages.map((message) => getCustomText(message))).toEqual([
			"",
			"status: dirty",
			"other key",
		]);
	});

	it("lets a context edit appended after the expiry point override it", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry("prelude", "think first", false, undefined, {
			until: "assistant_message",
		});
		session.appendContextEdit(id, { content: "edited before expiry" });
		session.appendMessage(assistant("answer"));
		expect(projectedRoles(session)).toEqual(["assistant"]);

		session.appendContextEdit(id, { content: "restored after expiry" });
		expect(session.buildSessionProjection().messages.map((message) => getCustomText(message))).toEqual([
			"restored after expiry",
			"",
		]);

		session.appendContextEdit(id, null);
		expect(projectedRoles(session)).toEqual(["assistant"]);
	});

	it("projects tail messages after every other message", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const tailId = session.appendCustomMessageEntry("status", "open files", false, undefined, undefined, "tail");
		session.appendMessage(assistant("answer"));
		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		const projection = session.buildSessionProjection();
		expect(projection.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "custom"]);
		expect(projection.entries.map((entry) => entry.sourceEntry.id).at(-1)).toBe(tailId);
		expect(session.getEntry(tailId)).toMatchObject({ position: "tail" });
	});
});
