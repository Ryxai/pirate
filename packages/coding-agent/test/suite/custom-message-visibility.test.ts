import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function texts(messages: AgentMessage[]): string[] {
	return messages.map((message) => `${message.role}:${getMessageText(message)}`);
}

describe("custom message visibility in agent runs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("sends an until-assistant_message prelude with one request and omits it afterwards", async () => {
		const requests: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.sendMessage({
							customType: "prelude",
							content: "prelude for this request",
							display: false,
							visibility: { until: "assistant_message" },
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("first");
			},
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(requests[0]).toEqual(["system:", "user:one", "user:prelude for this request"]);
		expect(requests[1]).toEqual([
			"system:",
			"user:one",
			"assistant:first",
			"user:two",
			"user:prelude for this request",
		]);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(2);
		// The finalized transcript matches the projection: both preludes have expired.
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("persists the visibility on boundary drafts", async () => {
		let handled = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						if (handled) return;
						handled = true;
						return {
							entries: [
								{
									type: "custom_message",
									customType: "scratch",
									content: "scratch",
									display: false,
									visibility: { until: "user_message" },
								},
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("one");
		const entry = harness.sessionManager.getBranch().find((entry) => entry.type === "custom_message");
		expect(entry).toMatchObject({ customType: "scratch", visibility: { until: "user_message" } });
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"custom",
		]);

		await harness.session.prompt("two");
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("sends a keyed tail message last and replaces it with the next one of the same key", async () => {
		const requests: string[][] = [];
		let turn = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						turn++;
						pi.sendMessage({
							customType: "status",
							content: `status ${turn}`,
							display: false,
							visibility: { key: "status" },
							position: "tail",
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("first");
			},
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(requests[0]).toEqual(["system:", "user:one", "user:status 1"]);
		expect(requests[1]).toEqual(["system:", "user:one", "assistant:first", "user:two", "user:status 2"]);
	});
});
