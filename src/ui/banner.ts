import { App, MarkdownView, WorkspaceLeaf } from "obsidian";
import type { UnreadController } from "../controller";
import type { UnreadChangesSettings } from "../settings";
import type { LocalStore } from "../services/local-store";
import { DiffModal } from "./diff-modal";
import { timeAgo } from "./format";

interface StickyBanner {
	path: string;
	/** lastReadAt captured when the banner FIRST appeared — markRead advancing
	 * read-state later must not make the attribution vanish mid-read. */
	sinceMs: number;
}

/**
 * Virtual "changed note" header: one sticky element inserted as first child of
 * the MarkdownView's contentEl — covers reading, live-preview and source modes
 * without touching the note file. Once shown for a file it stays while that
 * file is open in that leaf (so you can keep the summary/diff at hand even
 * after the dwell timer marks it read).
 */
export class BannerManager {
	/** leafId → banner element */
	private banners = new Map<string, HTMLElement>();
	/** leafId → sticky state (kept until the leaf shows a different file) */
	private sticky = new Map<string, StickyBanner>();

	constructor(
		private app: App,
		private controller: UnreadController,
		private store: LocalStore,
		private settings: () => UnreadChangesSettings,
	) {}

	async reconcile(): Promise<void> {
		const seenLeaves = new Set<string>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const leafId = this.leafId(leaf);
			if (!leafId) continue;
			seenLeaves.add(leafId);
			const view = leaf.view instanceof MarkdownView ? leaf.view : null;
			const path = view?.file?.path ?? null;

			const sticky = this.sticky.get(leafId);
			if (!path || (sticky && sticky.path !== path)) {
				this.remove(leafId);
			}
			if (!path || !view) continue;

			const shouldShow =
				this.settings().showBanner &&
				(this.controller.isUnread(path) || this.sticky.get(leafId)?.path === path);
			if (!shouldShow) {
				this.remove(leafId);
				continue;
			}
			let state = this.sticky.get(leafId);
			if (!state || state.path !== path) {
				state = { path, sinceMs: this.controller.lastReadAt(path) };
				this.sticky.set(leafId, state);
			}
			await this.render(leafId, view, state);
		}
		// leaves that no longer exist
		for (const leafId of [...this.banners.keys()]) {
			if (!seenLeaves.has(leafId)) this.remove(leafId);
		}
	}

	private async render(leafId: string, view: MarkdownView, state: StickyBanner): Promise<void> {
		const { path } = state;
		let banner = this.banners.get(leafId);
		if (!banner || banner.parentElement !== view.contentEl) {
			banner?.remove();
			banner = createDiv({ cls: "uc-banner" });
			view.contentEl.insertBefore(banner, view.contentEl.firstChild);
			this.banners.set(leafId, banner);
		}
		banner.empty();

		// entries newer than the read-state when the banner appeared; if a read
		// with a later wall-clock hides them all, fall back to the newest entry.
		const entry =
			(await this.controller.changelogReader.latestFor(path, state.sinceMs)) ??
			(await this.controller.changelogReader.latestFor(path, 0));
		const text = banner.createDiv({ cls: "uc-banner-text" });
		const isUnread = this.controller.isUnread(path);
		if (entry) {
			text.createSpan({ text: "Changed by " });
			text.createSpan({ cls: "uc-author", text: entry.author });
			text.createSpan({ text: ` · ${timeAgo(entry.at)}` });
			if (entry.summary) {
				text.createSpan({ text: " — " });
				text.createSpan({ cls: "uc-summary", text: entry.summary });
			}
		} else {
			const file = this.app.vault.getAbstractFileByPath(path);
			const mtime = file && "stat" in file ? (file as { stat: { mtime: number } }).stat.mtime : Date.now();
			text.createSpan({ text: isUnread ? "Changed since you last read it" : "Recently changed" });
			text.createSpan({ text: ` · ${timeAgo(mtime)} · ` });
			text.createSpan({ cls: "uc-summary", text: "no changelog entry (unattributed)" });
		}

		const actions = banner.createDiv({ cls: "uc-banner-actions" });
		const changelogFile = this.controller.changelogReader.changelogFile(path);
		if (changelogFile) {
			actions.createEl("button", { text: "Changelog" }).addEventListener("click", () => {
				void this.app.workspace.getLeaf(true).openFile(changelogFile);
			});
		}
		actions.createEl("button", { text: "Diff" }).addEventListener("click", () => {
			new DiffModal(this.app, this.controller, this.store, path).open();
		});
		const markButton = actions.createEl("button", { text: isUnread ? "Mark read" : "✓ Read" });
		markButton.disabled = !isUnread;
		markButton.addEventListener("click", () => void this.controller.markRead(path));
	}

	private remove(leafId: string): void {
		this.banners.get(leafId)?.remove();
		this.banners.delete(leafId);
		this.sticky.delete(leafId);
	}

	private leafId(leaf: WorkspaceLeaf): string | null {
		return (leaf as unknown as { id?: string }).id ?? null;
	}

	destroy(): void {
		for (const banner of this.banners.values()) banner.remove();
		this.banners.clear();
		this.sticky.clear();
	}
}
