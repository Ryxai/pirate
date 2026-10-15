import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_RECALL_TYPE, type ProjectedContext } from "../../src/core/context-projection.ts";
import type { OmittedReason, SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, firstUserEntryId, getMessageText, type Harness } from "./harness.ts";

function texts(messages: AgentMessage[]): string[] {
	return messages.map((message) => `${message.role}:${getMessageText(message)}`);
}

/** `role:text` of a content-bearing entry, as `texts()` labels its message. */
function entryLabel(entry: SessionEntry): string | undefined {
	if (entry.type === "message") return `${entry.message.role}:${getMessageText(entry.message)}`;
	if (entry.type === "custom_message") return `custom:${getMessageText(entry)}`;
	return undefined;
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

	it("re-sends a referenced entry's content under the message's own visibility", async () => {
		const requests: string[][] = [];
		let turn = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						turn++;
						if (turn !== 2) return;
						pi.sendMessage({
							customType: "recall",
							content: "replaced by the referenced entry",
							display: false,
							ref: firstUserEntryId(ctx.sessionManager.getBranch()),
							visibility: { until: "assistant_message" },
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("second");
			},
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("third");
			},
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.prompt("three");

		const branch = harness.sessionManager.getBranch();
		const userId = firstUserEntryId(branch);
		const recall = branch.find((entry) => entry.type === "custom_message");
		expect(recall).toMatchObject({
			customType: "recall",
			ref: userId,
			content: [{ type: "text", text: "one" }],
			visibility: { until: "assistant_message" },
		});
		// The request carries the referenced entry's text, and the copy expires like any other.
		expect(requests[0]).toEqual(["system:", "user:one", "assistant:first", "user:two", "user:one"]);
		expect(requests[1]).toEqual([
			"system:",
			"user:one",
			"assistant:first",
			"user:two",
			"assistant:second",
			"user:three",
		]);
		expect(harness.errors).toEqual([]);
	});

	it("reports a message whose ref names no entry instead of persisting it", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.sendMessage({ customType: "recall", content: "", display: false, ref: "missing" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("one");

		expect(harness.errors).toEqual([
			{ extensionPath: "<runtime>", event: "send_message", error: "Entry missing not found" },
		]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "custom_message")).toBe(false);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});

	it("accepts a boundary draft whose ref names an entry on another branch", async () => {
		let ref: string | undefined;
		let drafted = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						if (!ref || drafted) return;
						drafted = true;
						return {
							entries: [{ type: "custom_message", customType: "recall", content: "", display: false, ref }],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("one");
		const branch = harness.sessionManager.getBranch();
		ref = branch.find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
		// Branch from the first prompt: the referenced assistant entry is on the abandoned path.
		harness.sessionManager.branch(firstUserEntryId(branch));
		await harness.session.prompt("two");

		expect(harness.errors).toEqual([]);
		const recall = harness.sessionManager.getBranch().find((entry) => entry.type === "custom_message");
		expect(recall).toMatchObject({ customType: "recall", ref, content: [{ type: "text", text: "first" }] });
	});

	it("reports a result message whose ref names no entry and still delivers pending messages", async () => {
		const requests: string[][] = [];
		let turn = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						turn++;
						if (turn !== 2) return;
						return { message: { customType: "bad", content: "", display: false, ref: "missing" } };
					});
					pi.on("turn_end", () => {
						if (turn !== 1) return;
						pi.sendMessage({ customType: "later", content: "later", display: false }, { deliverAs: "nextTurn" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		// The run goes on without the bad message, and the pending nextTurn message is not lost.
		expect(harness.errors).toEqual([
			{ extensionPath: "<runtime>", event: "before_agent_start", error: "Entry missing not found" },
		]);
		expect(requests[0]).toEqual(["system:", "user:one", "assistant:first", "user:two", "user:later"]);
		const custom = harness.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");
		expect(custom.map((entry) => entry.customType)).toEqual(["later"]);
	});

	it("evicts canonical messages with a declared priority, lowest first, from a copy over the threshold", async () => {
		const requests: string[][] = [];
		let copy: ProjectedContext | undefined;
		const harness = await createHarness({
			// Threshold: 20_000 minus the default 16_384 reserve. Compaction stays off so the
			// canonical projection may exceed it.
			models: [{ id: "small", contextWindow: 20_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					// Steering delivers one sent message per poll; the result carries the other one.
					pi.on("before_agent_start", () => {
						pi.sendMessage({ customType: "high", content: "h".repeat(2_000), display: false, priority: 1 });
						return { message: { customType: "low", content: "l".repeat(12_000), display: false, priority: 0 } };
					});
					pi.on("context", (event, ctx) => {
						if (!event.model) return;
						copy = ctx.projectContext({ model: event.model });
						return { messages: copy.messages.filter((message) => message.role !== "system") };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requests.push(texts(context.messages).map((text) => text.slice(0, 12)));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("x".repeat(2_000));

		if (!copy) throw new Error("context handler did not run");
		const threshold = copy.budget.contextWindow - copy.budget.reserveTokens;
		expect(threshold).toBe(20_000 - 16_384);
		expect(copy.budget.baselineTokens).toBeGreaterThan(threshold);
		// Dropping the lowest priority is enough; the user message has no priority and stays.
		expect(copy.evicted.map((item) => [item.entry.sourceEntry.type, item.entry.priority, item.kind])).toEqual([
			["custom_message", 0, "canonical"],
		]);
		expect(copy.tokens).toBeLessThanOrEqual(threshold);
		expect(copy.tokens).toBe(copy.budget.baselineTokens - copy.evicted[0].tokens);
		expect(requests[0]).toEqual(["system:", `user:${"x".repeat(7)}`, `user:${"h".repeat(7)}`]);
		// Eviction is per request: the transcript keeps both messages, and no guard fired.
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"custom",
			"custom",
			"assistant",
		]);
		expect(harness.errors).toEqual([]);
	});

	it("drops a message once the entries after it exceed its token lifetime", async () => {
		const requests: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					let sent = false;
					pi.on("before_agent_start", () => {
						if (sent) return;
						sent = true;
						pi.sendMessage({
							customType: "hint",
							content: "hint",
							display: false,
							visibility: { until: { tokens: 100 } },
						});
					});
				},
			],
		});
		harnesses.push(harness);
		const first = "a".repeat(200);
		const second = "b".repeat(400);
		harness.setResponses([
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage(first);
			},
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage(second);
			},
			(context) => {
				requests.push(texts(context.messages));
				return fauxAssistantMessage("third");
			},
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.prompt("three");

		// 50 tokens of "first" and "two" are under the lifetime; the 100 of "second" push it over.
		expect(requests[0]).toEqual(["system:", "user:one", "user:hint"]);
		expect(requests[1]).toEqual(["system:", "user:one", "user:hint", `assistant:${first}`, "user:two"]);
		expect(requests[2]).toEqual([
			"system:",
			"user:one",
			`assistant:${first}`,
			"user:two",
			`assistant:${second}`,
			"user:three",
		]);
		const hint = harness.sessionManager.getBranch().find((entry) => entry.type === "custom_message");
		const projected = harness.sessionManager
			.buildSessionProjection()
			.entries.find((entry) => entry.sourceEntry.id === hint?.id);
		expect(projected).toMatchObject({ omitted: "expired", messages: [] });
	});

	it("tells a context handler why each entry is omitted", async () => {
		const reasons = new Map<string, OmittedReason | undefined>();
		let turn = 0;
		let edited = false;
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
						});
						if (turn !== 1) return;
						return {
							message: {
								customType: "prelude",
								content: "prelude",
								display: false,
								visibility: { until: "assistant_message" },
							},
						};
					});
					pi.on("turn_end", (_event, ctx) => {
						if (edited) return;
						edited = true;
						return {
							entries: [
								{
									type: "context_edit",
									targetId: firstUserEntryId(ctx.sessionManager.getBranch()),
									replacement: null,
								},
							],
						};
					});
					pi.on("context", (event, ctx) => {
						if (!event.model || turn !== 2) return;
						ctx.projectContext({
							model: event.model,
							filter: (entry, info) => {
								const label = entryLabel(entry.sourceEntry);
								if (label === undefined) return "default";
								// The reason of the projected entry and of the filter info agree.
								expect(entry.omitted).toBe(info.omitted);
								reasons.set(label, info.omitted);
								return "default";
							},
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect([...reasons]).toEqual([
			["system:", undefined],
			["user:one", "edit"],
			["custom:prelude", "expired"],
			["custom:status 1", "superseded"],
			["assistant:first", undefined],
			["user:two", undefined],
			["custom:status 2", undefined],
		]);
		expect(texts(harness.session.messages)).toEqual([
			"system:",
			"assistant:first",
			"user:two",
			"custom:status 2",
			"assistant:second",
		]);
	});
});
