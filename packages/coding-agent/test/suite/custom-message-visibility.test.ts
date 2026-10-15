import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_RECALL_TYPE } from "../../src/core/context-projection.ts";
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

	it("gives context handlers the routed model and budget, and projects a copy on request", async () => {
		const requests: string[][] = [];
		const seen: { model?: string; available?: number }[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.sendMessage({
							customType: "prelude",
							content: "prelude",
							display: false,
							visibility: { until: "assistant_message" },
						});
					});
					pi.on("context", (event, ctx) => {
						seen.push({ model: event.model?.id, available: event.budget?.available });
						if (!event.model) return;
						const copy = ctx.projectContext({
							model: event.model,
							filter: (entry, info) =>
								info.omitted && entry.sourceEntry.type === "custom_message" ? { include: true } : "default",
						});
						return { messages: copy.messages.filter((message) => message.role !== "system") };
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

		const model = harness.getModel();
		expect(seen).toHaveLength(2);
		expect(seen[0].model).toBe(model.id);
		expect(seen[0].available).toBeGreaterThan(0);
		expect(seen[0].available).toBeLessThan(model.contextWindow);
		// The first prelude expired; the second request recalls it at the tail after the live one.
		expect(requests[1]).toEqual([
			"system:",
			"user:one",
			"assistant:first",
			"user:two",
			"user:prelude",
			"user:prelude",
		]);
		const recalled = harness.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");
		expect(recalled.every((entry) => entry.customType !== CONTEXT_RECALL_TYPE)).toBe(true);
	});

	it("reports a context handler that grows the request past the compaction threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => {
						return {
							messages: [
								...event.messages,
								{ role: "user", content: "x".repeat(40_000), timestamp: Date.now() },
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("one");

		expect(harness.errors).toContainEqual(expect.objectContaining({ extensionPath: "<context>", event: "context" }));
		expect(harness.errors[0].error).toMatch(/past the compaction threshold/);
	});

	it("reports a context handler that shortens the cached prefix, only when cache notices are on", async () => {
		const run = async (showCacheMissNotices: boolean) => {
			let turn = 0;
			const harness = await createHarness({
				models: [{ id: "cached", cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } }],
				settings: { showCacheMissNotices },
				extensionFactories: [
					(pi) => {
						pi.on("context", (event) => {
							turn++;
							// Every other request drops the first user message: a mid-context change.
							return { messages: turn % 2 === 0 ? event.messages.slice(1) : event.messages };
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("one"),
				fauxAssistantMessage("two"),
				fauxAssistantMessage("three"),
			]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			await harness.session.prompt("third");
			return harness.errors.filter((error) => error.error.includes("cached"));
		};

		expect(await run(false)).toEqual([]);
		const reported = await run(true);
		expect(reported.map((error) => error.extensionPath)).toEqual(["<context>"]);
		expect(reported[0].error).toMatch(/from message 2 on/);
	});

	it("does not report tail-only additions as a shortened prefix", async () => {
		const harness = await createHarness({
			models: [{ id: "cached", cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } }],
			settings: { showCacheMissNotices: true },
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: [...event.messages, { role: "user", content: "reminder", timestamp: Date.now() }],
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.errors).toEqual([]);
	});
});
