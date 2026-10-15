import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { FieldKey } from "../../src/core/messages.ts";
import { fieldKey, getField } from "../../src/core/messages.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, firstUserEntryId, type Harness } from "./harness.ts";

const SCORE = { namespace: "scoring", name: "score", version: 1 };

function entriesOfType<T extends SessionEntry["type"]>(
	harness: Harness,
	type: T,
): Extract<SessionEntry, { type: T }>[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry): entry is Extract<SessionEntry, { type: T }> => entry.type === type);
}

describe("extension fields in agent runs", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	it("persists fields on sent messages and appended entries, readable with getField after a reload", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-fields-"));
		dirs.push(sessionDir);
		let key: FieldKey | undefined;
		const read: [SessionEntry["type"], number | undefined, FieldKey[]][] = [];
		const harness = await createHarness({
			sessionManager: SessionManager.create(sessionDir, sessionDir),
			extensionFactories: [
				(pi) => {
					key = pi.registerField(SCORE);
					pi.on("before_agent_start", () => {
						pi.sendMessage({
							customType: "note",
							content: "scored note",
							display: false,
							fields: { [key as string]: 3 },
						});
						pi.appendEntry("scoring-state", { total: 3 }, { [key as string]: 4 });
					});
					pi.on("turn_end", (_event, ctx) => {
						for (const entry of ctx.sessionManager.getBranch()) {
							if (entry.type !== "custom" && entry.type !== "custom_message") continue;
							read.push([
								entry.type,
								pi.getField<number>(entry, key as string),
								pi.listFields(entry, "scoring"),
							]);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("one");

		expect(key).toBe("scoring/score@1");
		expect(key).toBe(fieldKey("scoring", "score", 1));
		const [note] = entriesOfType(harness, "custom_message");
		const [state] = entriesOfType(harness, "custom");
		expect(note).toMatchObject({ customType: "note", content: "scored note", fields: { "scoring/score@1": 3 } });
		expect(state).toMatchObject({
			customType: "scoring-state",
			data: { total: 3 },
			fields: { "scoring/score@1": 4 },
		});
		expect(getField<number>(note, "scoring/score@1")).toBe(3);
		expect(getField<number>(state, "scoring/score@1")).toBe(4);
		expect(getField(note, "scoring/score@2")).toBeUndefined();
		// The extension read both entries back through its own API at turn_end.
		expect(read).toHaveLength(2);
		expect(read).toContainEqual(["custom_message", 3, ["scoring/score@1"]]);
		expect(read).toContainEqual(["custom", 4, ["scoring/score@1"]]);
		// The projected message carries the fields of its entry.
		expect(harness.session.messages.find((message) => message.role === "custom")).toMatchObject({
			customType: "note",
			fields: { "scoring/score@1": 3 },
		});

		// The fields survive the session file.
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("session was not persisted");
		const reopened = SessionManager.open(file).getBranch();
		expect(reopened.find((entry) => entry.type === "custom_message")).toMatchObject({
			fields: { "scoring/score@1": 3 },
		});
		expect(reopened.find((entry) => entry.type === "custom")).toMatchObject({
			data: { total: 3 },
			fields: { "scoring/score@1": 4 },
		});
	});

	it("returns the key to every registrant and reports a load-time conflict once a mode binds", async () => {
		const keys: FieldKey[] = [];
		const harness = await createHarness({
			extensionFactories: [
				{ name: "first", factory: (pi) => void keys.push(pi.registerField(SCORE)) },
				{
					name: "second",
					factory: (pi) => void keys.push(pi.registerField(SCORE), pi.registerField({ ...SCORE, version: 2 })),
				},
			],
		});
		harnesses.push(harness);

		expect(keys).toEqual(["scoring/score@1", "scoring/score@1", "scoring/score@2"]);
		// Conflicts found while extensions load are held until a mode binds and can show them.
		expect(harness.errors).toEqual([]);
		await harness.session.bindExtensions({});
		expect(harness.errors).toEqual([
			{
				extensionPath: "<inline:second>",
				event: "register_field",
				error: 'Field "scoring/score@1" is already registered by extension "<inline:first>"',
			},
		]);
	});

	it("reports a conflicting registration made at runtime immediately, and not a re-registration by the owner", async () => {
		const keys: FieldKey[] = [];
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "owner",
					factory: (pi) => {
						keys.push(pi.registerField(SCORE));
						pi.on("before_agent_start", () => void keys.push(pi.registerField(SCORE)));
					},
				},
				{
					name: "other",
					factory: (pi) => {
						pi.on("before_agent_start", () => void keys.push(pi.registerField(SCORE)));
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("one");

		expect(keys).toEqual(["scoring/score@1", "scoring/score@1", "scoring/score@1"]);
		expect(harness.errors).toEqual([
			{
				extensionPath: "<inline:other>",
				event: "register_field",
				error: 'Field "scoring/score@1" is already registered by extension "<inline:owner>"',
			},
		]);
	});
});

describe("annotations in agent runs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("annotates at turn_end through a boundary draft and pi.annotate, visible to later handlers", async () => {
		const score = fieldKey("scoring", "score", 1);
		const note = fieldKey("scoring", "note", 1);
		let turn = 0;
		let firstAssistantId: string | undefined;
		const fromManager: Record<FieldKey, JsonValue>[] = [];
		const fromFilter = new Map<string, Record<FieldKey, JsonValue>>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					expect(pi.registerField({ namespace: "scoring", name: "score", version: 1 })).toBe(score);
					expect(pi.registerField({ namespace: "scoring", name: "note", version: 1 })).toBe(note);
					pi.on("turn_end", (event, ctx) => {
						turn++;
						const userId = firstUserEntryId(ctx.sessionManager.getBranch());
						if (turn === 1) {
							firstAssistantId = event.messageEntryId;
							pi.annotate(userId, { [score]: 1, [note]: "first" });
							return {
								entries: [{ type: "annotation", targetId: event.messageEntryId, fields: { [score]: 2 } }],
							};
						}
						// The latest value per key wins and null clears a key.
						pi.annotate(userId, { [score]: 5, [note]: null });
						fromManager.push(ctx.sessionManager.getAnnotations(userId));
					});
					pi.on("context", (event, ctx) => {
						if (!event.model || turn !== 1) return;
						fromManager.push(ctx.sessionManager.getAnnotations(firstUserEntryId(ctx.sessionManager.getBranch())));
						ctx.projectContext({
							model: event.model,
							filter: (entry, info) => {
								fromFilter.set(entry.sourceEntry.id, info.annotations);
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

		const branch = harness.sessionManager.getBranch();
		const userId = firstUserEntryId(branch);
		if (!firstAssistantId) throw new Error("missing assistant entry");
		// Turn 2's context handler saw the annotations of turn 1 on both targets, through the
		// session manager and the projection filter.
		expect(fromManager[0]).toEqual({ [score]: 1, [note]: "first" });
		expect(fromFilter.get(userId)).toEqual({ [score]: 1, [note]: "first" });
		expect(fromFilter.get(firstAssistantId)).toEqual({ [score]: 2 });
		expect([...fromFilter.values()].filter((fields) => Object.keys(fields).length > 0)).toHaveLength(2);
		// Turn 2's turn_end read its own update right away.
		expect(fromManager[1]).toEqual({ [score]: 5 });
		expect(harness.sessionManager.getAnnotations(userId)).toEqual({ [score]: 5 });
		expect(harness.sessionManager.getAnnotations(firstAssistantId)).toEqual({ [score]: 2 });

		// Both paths append annotation entries, with null kept on the entry, and emit them.
		const annotations = branch.filter((entry) => entry.type === "annotation");
		expect(annotations).toEqual([
			expect.objectContaining({ targetId: userId, fields: { [score]: 1, [note]: "first" } }),
			expect.objectContaining({ targetId: firstAssistantId, fields: { [score]: 2 } }),
			expect.objectContaining({ targetId: userId, fields: { [score]: 5, [note]: null } }),
		]);
		expect(
			harness
				.eventsOfType("entry_appended")
				.map((event) => event.entry)
				.filter((entry) => entry.type === "annotation"),
		).toEqual(annotations);
		// Annotations add nothing to model context.
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("reports pi.annotate on an entry that does not exist as an extension error", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						pi.annotate("missing", { [fieldKey("scoring", "score", 1)]: 1 });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("one");

		expect(harness.errors).toEqual([
			expect.objectContaining({ extensionPath: "<inline:1>", event: "turn_end", error: "Entry missing not found" }),
		]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "annotation")).toBe(false);
	});
});
