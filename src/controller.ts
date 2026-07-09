import { App, MarkdownView, TFile, debounce } from "obsidian";
import { diffBaseline } from "./core/baseline";
import { notePathFor } from "./core/changelog";
import { hashContent } from "./core/hash";
import {
	emptyDeviceState,
	mergeDeviceStates,
	recordMarkUnread,
	recordRead,
	removePath,
	renamePath,
} from "./core/read-state";
import type { Baseline, DeviceState, MergedState, ReadEvent, UnreadInfo } from "./core/types";
import { computeUnread, folderUnreadCounts, isExcluded } from "./core/unread";
import { ChangelogReader } from "./services/changelog-reader";
import { LocalStore } from "./services/local-store";
import { StateSync } from "./services/state-sync";
import { effectiveExclusions, type UnreadChangesSettings } from "./settings";

/** Deleted-note state kept briefly so delete+recreate (atomic replace) reads as a modify. */
interface DeleteTombstone {
	baseline: Baseline[string];
	read?: ReadEvent;
	unreadMark?: number;
	timer: number;
}

const HASH_CONCURRENCY = 16;

async function mapChunked<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	}
	return out;
}

/**
 * Central state: owns the device read-state, baseline, merged view and the
 * unread set; everything UI subscribes here.
 */
export class UnreadController {
	private ownState: DeviceState;
	private otherStates = new Map<string, DeviceState>();
	private baseline: Baseline = {};
	private merged: MergedState = { reads: {}, unreadMarks: {} };
	private unread = new Map<string, UnreadInfo>();
	private listeners = new Set<() => void>();
	/** path → last local editor activity (epoch ms), for self-edit detection */
	private editorActivity = new Map<string, number>();
	private pendingDeletes = new Map<string, DeleteTombstone>();
	private saveOwnStateDebounced: () => void;
	private saveBaselineDebounced: () => void;
	readonly deviceId: string;

	constructor(
		private app: App,
		private settings: () => UnreadChangesSettings,
		private deviceName: () => string,
		private store: LocalStore,
		private stateSync: StateSync,
		readonly changelogReader: ChangelogReader,
		deviceId: string,
	) {
		this.deviceId = deviceId;
		this.ownState = emptyDeviceState(this.deviceId, deviceName() || this.deviceId);
		this.saveOwnStateDebounced = debounce(() => void this.saveOwnState(), 1500, true);
		this.saveBaselineDebounced = debounce(() => void this.store.saveBaseline(this.baseline), 2000, true);
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	/** Full scan: reconcile baseline, load device states, recompute unread. */
	async initialize(): Promise<void> {
		this.baseline = await this.store.loadBaseline();
		const states = await this.stateSync.loadAll();
		const own = states.find((s) => s.deviceId === this.deviceId);
		if (own) this.ownState = own;
		this.otherStates = new Map(
			states.filter((s) => s.deviceId !== this.deviceId).map((s) => [s.deviceId, s]),
		);

		// Seed only on a genuinely fresh vault: no state files anywhere AND this
		// install never initialized before (a renamed state folder must not re-seed).
		const firstEverInstall = states.length === 0 && !this.store.hasInitialized();
		await this.rescan();

		if (firstEverInstall) {
			// Seed everything as read — never light up the whole vault on install.
			// Snapshots too, so the FIRST change to a never-opened note still has a diff base.
			const now = Date.now();
			const notes: DeviceState["notes"] = {};
			await mapChunked(Object.entries(this.baseline), HASH_CONCURRENCY, async ([path, entry]) => {
				notes[path] = { readAt: now, hash: entry.hash };
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					try {
						const content = await this.app.vault.cachedRead(file);
						await this.store.saveSnapshot(path, { hash: entry.hash, content, takenAt: now });
					} catch {
						// snapshot is best-effort; diff falls back to changelog
					}
				}
			});
			this.ownState = { ...this.ownState, notes };
			await this.saveOwnState();
			this.recompute();
		}
		this.store.markInitialized();
	}

	/** Re-stat + re-hash changed files, refresh merged unread set. */
	async rescan(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		const exclusions = effectiveExclusions(this.settings());
		const tracked = files.filter((f) => !isExcluded(f.path, exclusions));
		const stats = tracked.map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
		const diff = diffBaseline(stats, this.baseline);

		const next: Baseline = {};
		for (const [path, hash] of diff.unchanged) {
			next[path] = this.baseline[path] ?? { mtime: 0, size: 0, hash };
		}
		await mapChunked(diff.candidates, HASH_CONCURRENCY, async (path) => {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			try {
				const hash = await hashContent(await this.app.vault.cachedRead(file));
				next[path] = { mtime: file.stat.mtime, size: file.stat.size, hash };
			} catch {
				// unreadable — keep the old entry if any so we retry later
				const old = this.baseline[path];
				if (old) next[path] = old;
			}
		});
		// Files deleted while the app was closed: prune our read-state + snapshots.
		for (const path of diff.deleted) {
			this.ownState = removePath(this.ownState, path);
			void this.store.removeSnapshot(path);
		}
		if (diff.deleted.length > 0) this.saveOwnStateDebounced();
		this.baseline = next;
		this.saveBaselineDebounced();
		this.recompute();
	}

	private recompute(): void {
		this.merged = mergeDeviceStates([this.ownState, ...this.otherStates.values()]);
		const files = Object.entries(this.baseline).map(([path, entry]) => ({ path, hash: entry.hash }));
		const infos = computeUnread(files, this.merged, effectiveExclusions(this.settings()));
		this.unread = new Map(infos.map((info) => [info.path, info]));
		this.emitChanged();
	}

	// ── queries ──────────────────────────────────────────────────────────────

	isUnread(path: string): boolean {
		return this.unread.has(path);
	}

	getUnread(): UnreadInfo[] {
		return [...this.unread.values()];
	}

	unreadPaths(): Set<string> {
		return new Set(this.unread.keys());
	}

	folderCounts(): Map<string, number> {
		return folderUnreadCounts([...this.unread.keys()]);
	}

	/** Latest read event for a path across all devices (for "since you last read"). */
	lastReadAt(path: string): number {
		return this.merged.reads[path]?.readAt ?? 0;
	}

	isTrackedNote(path: string): boolean {
		return path.endsWith(".md") && !isExcluded(path, effectiveExclusions(this.settings()));
	}

	// ── mutations ────────────────────────────────────────────────────────────

	async markRead(path: string): Promise<void> {
		await this.markReadInternal(path);
		this.saveOwnStateDebounced();
		this.saveBaselineDebounced();
		this.recompute();
	}

	private async markReadInternal(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		let content: string;
		try {
			content = await this.app.vault.cachedRead(file);
		} catch {
			return;
		}
		const hash = await hashContent(content);
		const now = Date.now();
		this.ownState = recordRead(this.ownState, path, hash, now);
		this.baseline[path] = { mtime: file.stat.mtime, size: file.stat.size, hash };
		await this.store.saveSnapshot(path, { hash, content, takenAt: now });
	}

	markUnread(path: string): void {
		this.ownState = recordMarkUnread(this.ownState, path, Date.now());
		this.saveOwnStateDebounced();
		this.recompute();
	}

	async markFolderRead(folderPath: string): Promise<void> {
		const prefix = folderPath === "/" || folderPath === "" ? "" : folderPath + "/";
		const targets = [...this.unread.keys()].filter((p) => prefix === "" || p.startsWith(prefix));
		await mapChunked(targets, HASH_CONCURRENCY, (path) => this.markReadInternal(path));
		this.saveOwnStateDebounced();
		this.saveBaselineDebounced();
		this.recompute();
	}

	async markAllRead(): Promise<void> {
		await this.markFolderRead("");
	}

	// ── event handlers (wired by main.ts, after layout-ready) ───────────────

	noteEditorActivity(path: string): void {
		this.editorActivity.set(path, Date.now());
	}

	async onVaultModify(file: TFile): Promise<void> {
		if (this.stateSync.consumeOwnWriteEcho(file.path)) return;
		if (this.stateSync.isStateFile(file.path)) {
			await this.onStateFileChanged(file.path);
			return;
		}
		if (!this.isTrackedNote(file.path)) {
			this.changelogInvalidate(file.path);
			return;
		}
		if (await this.isLocalEdit(file)) {
			// Your own typing never lights up your own device.
			await this.markRead(file.path);
			return;
		}
		try {
			const hash = await hashContent(await this.app.vault.cachedRead(file));
			this.baseline[file.path] = { mtime: file.stat.mtime, size: file.stat.size, hash };
			this.saveBaselineDebounced();
			this.recompute();
		} catch {
			// transient read failure (mid-sync) — next event/scan catches up
		}
	}

	/**
	 * A modify is a local edit only when the editor was recently active on this
	 * path AND the disk content matches an open editor buffer — a sync write
	 * landing while you type differs from your buffer and stays external.
	 */
	private async isLocalEdit(file: TFile): Promise<boolean> {
		const activity = this.editorActivity.get(file.path) ?? 0;
		if (Date.now() - activity >= 2500) return false;
		const view = this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
		if (!view) return false;
		try {
			return view.editor.getValue() === (await this.app.vault.cachedRead(file));
		} catch {
			return false;
		}
	}

	async onVaultCreate(file: TFile): Promise<void> {
		if (this.stateSync.consumeOwnWriteEcho(file.path)) return;
		if (this.stateSync.isStateFile(file.path)) {
			await this.onStateFileChanged(file.path);
			return;
		}
		if (!this.isTrackedNote(file.path)) {
			this.changelogInvalidate(file.path);
			return;
		}
		// delete+create of the same path within the grace window = an atomic
		// replace (external swap) — restore the read record so hashes decide.
		const tombstone = this.pendingDeletes.get(file.path);
		if (tombstone) {
			window.clearTimeout(tombstone.timer);
			this.pendingDeletes.delete(file.path);
			const notes = { ...this.ownState.notes };
			const unread = { ...this.ownState.unread };
			if (tombstone.read) notes[file.path] = tombstone.read;
			if (tombstone.unreadMark !== undefined) unread[file.path] = tombstone.unreadMark;
			this.ownState = { ...this.ownState, notes, unread };
		}
		await this.onVaultModify(file);
	}

	onVaultDelete(path: string): void {
		if (this.stateSync.isStateFile(path)) {
			// another device's state file removed — drop it from the merge
			for (const deviceId of [...this.otherStates.keys()]) {
				if (path.endsWith(`/${deviceId}.json`)) this.otherStates.delete(deviceId);
			}
			this.recompute();
			return;
		}
		const entry = this.baseline[path];
		if (entry) {
			// keep a short-lived tombstone so delete+recreate reads as modify
			const tombstone: DeleteTombstone = {
				baseline: entry,
				read: this.ownState.notes[path],
				unreadMark: this.ownState.unread[path],
				timer: window.setTimeout(() => {
					this.pendingDeletes.delete(path);
					void this.store.removeSnapshot(path);
				}, 1200),
			};
			this.pendingDeletes.set(path, tombstone);
			delete this.baseline[path];
			this.ownState = removePath(this.ownState, path);
			this.saveOwnStateDebounced();
			this.saveBaselineDebounced();
			this.recompute();
		}
	}

	async onVaultRename(file: TFile, oldPath: string): Promise<void> {
		const entry = this.baseline[oldPath];
		if (entry) {
			delete this.baseline[oldPath];
			if (this.isTrackedNote(file.path)) this.baseline[file.path] = entry;
			this.ownState = renamePath(this.ownState, oldPath, file.path);
			await this.store.renameSnapshot(oldPath, file.path);
			await this.stateSync.renameChangelog(oldPath, file.path, this.settings().changelogFolder);
			this.changelogReader.invalidate(oldPath);
			this.changelogReader.invalidate(file.path);
			this.saveOwnStateDebounced();
			this.saveBaselineDebounced();
			this.recompute();
		} else if (this.isTrackedNote(file.path)) {
			// moved INTO tracked scope
			await this.onVaultModify(file);
		}
	}

	private async onStateFileChanged(path: string): Promise<void> {
		if (this.stateSync.isOwnStateFile(path)) return; // echo already filtered; ignore
		const state = await this.stateSync.loadOne(path);
		if (state && state.deviceId !== this.deviceId) {
			this.otherStates.set(state.deviceId, state);
			this.recompute();
		}
	}

	private changelogInvalidate(path: string): void {
		const notePath = notePathFor(path, this.settings().changelogFolder);
		if (notePath !== null) {
			this.changelogReader.invalidate(notePath);
			this.emitChanged(); // banner/inbox may show fresher attribution
		}
	}

	private async saveOwnState(): Promise<void> {
		this.ownState = { ...this.ownState, deviceName: this.deviceName() || this.deviceId };
		try {
			await this.stateSync.writeOwn(this.ownState);
		} catch (e) {
			console.error("unread-changes: failed to write state file", e);
		}
	}

	// ── change notification ──────────────────────────────────────────────────

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emitChanged(): void {
		for (const listener of this.listeners) listener();
	}

	/** Flush pending writes (called from onunload). */
	async flush(): Promise<void> {
		await this.saveOwnState();
		await this.store.saveBaseline(this.baseline);
	}
}
