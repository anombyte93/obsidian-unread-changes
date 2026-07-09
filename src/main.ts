import { MarkdownView, Menu, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, debounce } from "obsidian";
import { UnreadController } from "./controller";
import { ChangelogReader } from "./services/changelog-reader";
import { LocalStore } from "./services/local-store";
import { StateSync } from "./services/state-sync";
import { DEFAULT_SETTINGS, UnreadChangesSettingTab, type UnreadChangesSettings } from "./settings";
import { BadgeManager } from "./ui/badges";
import { BannerManager } from "./ui/banner";
import { DiffModal } from "./ui/diff-modal";
import { INBOX_VIEW_TYPE, InboxView } from "./ui/inbox-view";

export default class UnreadChangesPlugin extends Plugin {
	settings: UnreadChangesSettings = { ...DEFAULT_SETTINGS };
	controller: UnreadController | null = null;
	private badges: BadgeManager | null = null;
	private banner: BannerManager | null = null;
	private store: LocalStore | null = null;
	private dwellTimer: number | null = null;

	async onload(): Promise<void> {
		this.store = new LocalStore(this.app);
		await this.loadSettings();

		const deviceId = this.store.getDeviceId();
		if (!this.store.getDeviceName()) {
			this.store.setDeviceName(Platform.isMobile ? "Mobile" : "Desktop");
		}

		const stateSync = new StateSync(this.app.vault, () => this.settings.stateFolder, deviceId);
		const changelogReader = new ChangelogReader(this.app.vault, () => this.settings.changelogFolder);
		this.controller = new UnreadController(
			this.app,
			() => this.settings,
			() => this.getDeviceName(),
			this.store,
			stateSync,
			changelogReader,
			deviceId,
		);
		this.badges = new BadgeManager(this.app, this.controller, () => this.settings);
		this.banner = new BannerManager(this.app, this.controller, this.store, () => this.settings);

		this.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxView(leaf, this.controller!));
		this.addSettingTab(new UnreadChangesSettingTab(this.app, this));
		this.addRibbonIcon("inbox", "Unread changes", () => void this.activateInbox());
		this.registerCommands();
		this.registerFileMenu();

		this.controller.onChange(() => {
			this.badges?.schedule();
			void this.banner?.reconcile();
			// a note can turn unread WHILE focused (sync write) — re-arm the dwell timer
			this.handleFileFocus();
		});

		// Everything that reads vault state waits for layout-ready — this also
		// dodges the 'create'-event flood Obsidian fires for existing files at load.
		this.app.workspace.onLayoutReady(() => void this.startTracking());
	}

	private async startTracking(): Promise<void> {
		const controller = this.controller!;
		await controller.initialize();

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) void controller.onVaultModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) void controller.onVaultCreate(file);
			}),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => controller.onVaultDelete(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) void controller.onVaultRename(file, oldPath);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				const file = info.file;
				if (file) controller.noteEditorActivity(file.path);
			}),
		);

		const onActiveChange = debounce(
			() => {
				this.handleFileFocus();
				void this.banner?.reconcile();
			},
			250,
			true,
		);
		this.registerEvent(this.app.workspace.on("active-leaf-change", onActiveChange));
		this.registerEvent(this.app.workspace.on("file-open", onActiveChange));
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.badges?.schedule();
				void this.banner?.reconcile();
			}),
		);

		// Post-sync catch-up when remotely-save is present (best-effort, internal API).
		const remotelySave = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins
			?.plugins?.["remotely-save"] as { syncEvent?: { on: (name: string, cb: () => void) => unknown } } | undefined;
		if (remotelySave?.syncEvent?.on) {
			remotelySave.syncEvent.on("SYNC_DONE", () => void controller.rescan());
		}

		this.badges?.schedule();
		void this.banner?.reconcile();
	}

	/** Dwell/instant mark-as-read for the newly focused note. */
	private handleFileFocus(): void {
		if (this.dwellTimer !== null) {
			window.clearTimeout(this.dwellTimer);
			this.dwellTimer = null;
		}
		const mode = this.settings.markReadMode;
		if (mode === "manual") return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const path = view?.file?.path;
		if (!path || !this.controller?.isUnread(path)) return;
		if (mode === "instant") {
			void this.controller.markRead(path);
			return;
		}
		this.dwellTimer = window.setTimeout(() => {
			this.dwellTimer = null;
			const stillActive = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path === path;
			if (stillActive) void this.controller?.markRead(path);
		}, this.settings.dwellSeconds * 1000);
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-inbox",
			name: "Open unread inbox",
			callback: () => void this.activateInbox(),
		});
		this.addCommand({
			id: "mark-current-read",
			name: "Mark current note as read",
			checkCallback: (checking) => {
				const path = this.activeNotePath();
				if (!path) return false;
				if (!checking) void this.controller?.markRead(path);
				return true;
			},
		});
		this.addCommand({
			id: "mark-current-unread",
			name: "Mark current note as unread",
			checkCallback: (checking) => {
				const path = this.activeNotePath();
				if (!path) return false;
				if (!checking) this.controller?.markUnread(path);
				return true;
			},
		});
		this.addCommand({
			id: "mark-all-read",
			name: "Mark all notes as read",
			callback: () => {
				void this.controller?.markAllRead().then(() => new Notice("All notes marked read."));
			},
		});
		this.addCommand({
			id: "rescan",
			name: "Rescan vault for changes",
			callback: () => {
				void this.controller?.rescan().then(() => new Notice("Vault rescanned."));
			},
		});
		this.addCommand({
			id: "show-diff",
			name: "Show changes since last read",
			checkCallback: (checking) => {
				const path = this.activeNotePath();
				if (!path) return false;
				if (!checking) new DiffModal(this.app, this.controller!, this.store!, path).open();
				return true;
			},
		});
		this.addCommand({
			id: "open-changelog",
			name: "Open changelog for current note",
			checkCallback: (checking) => {
				const path = this.activeNotePath();
				if (!path) return false;
				const file = this.controller?.changelogReader.changelogFile(path);
				if (!file) return false;
				if (!checking) void this.app.workspace.getLeaf(true).openFile(file);
				return true;
			},
		});
	}

	private registerFileMenu(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				const controller = this.controller;
				if (!controller) return;
				if (file instanceof TFile && controller.isTrackedNote(file.path)) {
					if (controller.isUnread(file.path)) {
						menu.addItem((item) =>
							item
								.setTitle("Mark as read")
								.setIcon("check")
								.onClick(() => void controller.markRead(file.path)),
						);
					} else {
						menu.addItem((item) =>
							item
								.setTitle("Mark as unread")
								.setIcon("dot")
								.onClick(() => controller.markUnread(file.path)),
						);
					}
				} else if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Mark folder as read")
							.setIcon("check-check")
							.onClick(() => void controller.markFolderRead(file.path)),
					);
				}
			}),
		);
	}

	private activeNotePath(): string | null {
		const path = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
		return path && this.controller?.isTrackedNote(path) ? path : null;
	}

	private async activateInbox(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	getDeviceName(): string {
		return this.store?.getDeviceName() ?? "";
	}

	setDeviceName(name: string): void {
		this.store?.setDeviceName(name);
	}

	async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		// deviceName used to live here; it is per-device and must not ride a synced data.json
		const legacyName = typeof raw.deviceName === "string" ? raw.deviceName : "";
		delete raw.deviceName;
		this.settings = { ...DEFAULT_SETTINGS, ...raw };
		if (legacyName && this.store && !this.store.getDeviceName()) this.store.setDeviceName(legacyName);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onunload(): void {
		if (this.dwellTimer !== null) window.clearTimeout(this.dwellTimer);
		this.badges?.destroy();
		this.banner?.destroy();
		void this.controller?.flush();
	}
}
