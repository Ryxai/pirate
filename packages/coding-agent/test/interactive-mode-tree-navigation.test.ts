import { stripVTControlCharacters } from "node:util";
import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { CustomMessageChatItem, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const busyMessage = "Wait for the current compaction or tree navigation to finish before navigating the session tree.";

function createTreeUI() {
	const sessionManager = SessionManager.inMemory();
	const targetId = sessionManager.appendMessage(userMsg("first"));
	sessionManager.appendCustomMessageEntry({
		customType: "note",
		content: "temporary",
		display: true,
		visibility: { until: "assistant_message" },
	});
	sessionManager.appendMessage(assistantMsg("reply"));
	let selector: TreeSelectorComponent | undefined;
	const onEscape = vi.fn();
	const ui = {
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		session: {
			isStreaming: false,
			isCompacting: false,
			abort: vi.fn(async () => {
				ui.session.isStreaming = false;
			}),
			abortBranchSummary: vi.fn(),
			navigateTree: vi.fn(async () => {
				if (ui.session.isCompacting) throw new Error(busyMessage);
				return { cancelled: false };
			}),
		},
		defaultEditor: { onEscape },
		editor: { getText: () => "", setText: vi.fn() },
		chatContainer: new Container(),
		clearChat: vi.fn(),
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: { terminal: { rows: 24, setProgress: vi.fn() }, requestRender: vi.fn() },
		showSelector: (
			create: (done: () => void) => { component: TreeSelectorComponent; focus: TreeSelectorComponent },
		) => {
			selector = create(vi.fn()).component;
		},
		showExtensionSelector: vi.fn(async () => "No summary"),
		// Dispose newly created indicators so a failing regression cannot leak spinner timers.
		showStatusIndicator: vi.fn((indicator: StatusIndicator) => indicator.dispose()),
		clearStatusIndicator: vi.fn(),
		restoreQueuedMessagesToEditor: vi.fn(),
		renderInitialMessages: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
	};
	const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof ui) => void;
	showTreeSelector.call(ui);

	return {
		ui,
		onEscape,
		targetId,
		selector,
		async select() {
			expect(selector).toBeDefined();
			await selector!.getTreeList().onSelect!(targetId);
		},
	};
}

describe("InteractiveMode tree navigation availability", () => {
	beforeEach(() => initTheme("dark"));

	// Regression for #9178 / PR #9179: rejection must not replace the active operation's UI.
	it.each(["Summarize", "No summary"])("preserves operation UI when choosing %s while busy", async (choice) => {
		const { ui, onEscape, select } = createTreeUI();
		const originalLeafId = ui.sessionManager.getLeafId();
		ui.showExtensionSelector.mockImplementation(async () => {
			// Compaction or another navigation can start while the dialog is open.
			ui.session.isCompacting = true;
			return choice;
		});

		await select();

		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
		expect(ui.session.abort).not.toHaveBeenCalled();
		expect(ui.sessionManager.getLeafId()).toBe(originalLeafId);
	});

	it("allows navigation when compaction finishes while the dialog is open", async () => {
		const { ui, targetId, select } = createTreeUI();
		ui.session.isCompacting = true;
		ui.showExtensionSelector.mockImplementation(async () => {
			ui.session.isCompacting = false;
			return "No summary";
		});

		await select();

		expect(ui.session.navigateTree).toHaveBeenCalledWith(targetId, {
			summarize: false,
			customInstructions: undefined,
		});
		expect(ui.showError).not.toHaveBeenCalled();
	});

	it("still aborts an active response before navigating", async () => {
		const { ui, select } = createTreeUI();
		ui.session.isStreaming = true;
		ui.session.navigateTree.mockImplementation(async () => {
			expect(ui.session.isStreaming).toBe(false);
			expect(ui.restoreQueuedMessagesToEditor).toHaveBeenCalledOnce();
			return { cancelled: false };
		});

		await select();

		expect(ui.session.abort).toHaveBeenCalledOnce();
		expect(ui.session.navigateTree).toHaveBeenCalledOnce();
		expect(ui.showError).not.toHaveBeenCalled();
	});

	it("marks custom messages that no longer contribute on the branch", () => {
		const { selector } = createTreeUI();
		expect(selector).toBeDefined();
		const rendered = stripVTControlCharacters(selector!.getTreeList().render(200).join("\n"));
		expect(rendered).toContain("[expired] [note]: temporary");
	});

	it("rechecks availability after the response abort settles", async () => {
		const { ui, onEscape, select } = createTreeUI();
		ui.session.isStreaming = true;
		ui.showExtensionSelector.mockResolvedValue("Summarize");
		ui.session.abort.mockImplementation(async () => {
			ui.session.isStreaming = false;
			ui.session.isCompacting = true;
		});

		await select();

		expect(ui.session.abort).toHaveBeenCalledOnce();
		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode custom message markers", () => {
	beforeEach(() => initTheme("dark"));

	type MarkerUI = {
		sessionManager: SessionManager;
		customMessageItems: Map<string, CustomMessageChatItem>;
		unkeyedCustomMessageItems: CustomMessageChatItem[];
		ui: { requestRender: () => void };
	};
	const refresh = Reflect.get(InteractiveMode.prototype, "refreshCustomMessageMarkers") as (this: MarkerUI) => void;

	function noteItem(text: string): CustomMessageChatItem {
		const message: CustomMessage = { role: "custom", customType: "note", content: text, display: true, timestamp: 0 };
		return new CustomMessageChatItem(new CustomMessageComponent(message), 1);
	}

	const rendered = (item: CustomMessageChatItem) => stripVTControlCharacters(item.render(80).join("\n"));

	it("keys items rendered before persistence and notes expired messages", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMsg("first"));
		const noteId = sessionManager.appendCustomMessageEntry({
			customType: "note",
			content: "temporary",
			display: true,
			visibility: { until: "assistant_message" },
		});
		const pending = noteItem("temporary");
		const ui: MarkerUI = {
			sessionManager,
			customMessageItems: new Map(),
			unkeyedCustomMessageItems: [pending],
			ui: { requestRender: vi.fn() },
		};

		refresh.call(ui);
		expect(ui.customMessageItems.get(noteId)).toBe(pending);
		expect(ui.unkeyedCustomMessageItems).toEqual([]);
		expect(rendered(pending)).not.toContain("expired");

		sessionManager.appendMessage(assistantMsg("reply"));
		refresh.call(ui);
		expect(rendered(pending)).toContain("expired");
		expect(ui.ui.requestRender).toHaveBeenCalled();
	});

	it("notes omitted and superseded messages", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMsg("first"));
		const omittedId = sessionManager.appendCustomMessageEntry({ customType: "note", content: "cut", display: true });
		const olderId = sessionManager.appendCustomMessageEntry({
			customType: "note",
			content: "older",
			display: true,
			visibility: { key: "status" },
		});
		const newerId = sessionManager.appendCustomMessageEntry({
			customType: "note",
			content: "newer",
			display: true,
			visibility: { key: "status" },
		});
		sessionManager.appendContextEdit(omittedId, null);
		const items = new Map([
			[omittedId, noteItem("cut")],
			[olderId, noteItem("older")],
			[newerId, noteItem("newer")],
		]);
		const ui: MarkerUI = {
			sessionManager,
			customMessageItems: items,
			unkeyedCustomMessageItems: [],
			ui: { requestRender: vi.fn() },
		};

		refresh.call(ui);

		expect(rendered(items.get(omittedId)!)).toContain("omitted");
		expect(rendered(items.get(olderId)!)).toContain("superseded");
		expect(rendered(items.get(newerId)!)).not.toContain("superseded");
	});

	it("refreshes the markers when a turn starts or ends and when an entry is appended", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: false,
			clearStatusIndicator: vi.fn(),
			handleEntryAppended: vi.fn(),
			refreshCustomMessageMarkers: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" } | { type: "turn_end" } | { type: "entry_appended"; entry: SessionEntry },
		) => Promise<void>;
		const edit: SessionEntry = {
			type: "context_edit",
			id: "edit-1",
			parentId: "note-1",
			timestamp: new Date().toISOString(),
			targetId: "note-1",
			replacement: null,
		};

		await handleEvent.call(fakeThis, { type: "turn_start" });
		await handleEvent.call(fakeThis, { type: "turn_end" });
		await handleEvent.call(fakeThis, { type: "entry_appended", entry: edit });

		expect(fakeThis.refreshCustomMessageMarkers).toHaveBeenCalledTimes(3);
		expect(fakeThis.handleEntryAppended).toHaveBeenCalledWith(edit);
	});
});
