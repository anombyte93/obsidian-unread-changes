import { requireApiVersion, WorkspaceLeaf, type App, type View } from "obsidian";
import type { UnreadController } from "../controller";
import type { UnreadChangesSettings } from "../settings";

/** The undocumented parts of the file-explorer view we rely on (isolated here). */
interface FileExplorerItem {
	selfEl: HTMLElement;
}
interface FileExplorerView extends View {
	fileItems: Record<string, FileExplorerItem>;
}

const FILE_CLASS = "uc-unread";
const FOLDER_CLASS = "uc-has-unread";
const COUNT_ATTR = "data-uc-count";

/**
 * Decorates the file explorer: unread dot on files, rollup count on folders.
 * Pure DOM class/attr writes on `fileItems[path].selfEl` — these persist across
 * the explorer's virtualized re-renders; a childList MutationObserver catches
 * full re-renders (our own attribute writes never re-trigger it).
 */
export class BadgeManager {
	private observers: MutationObserver[] = [];
	private observedContainers = new WeakSet<HTMLElement>();
	private rafHandle = 0;

	constructor(
		private app: App,
		private controller: UnreadController,
		private settings: () => UnreadChangesSettings,
	) {}

	/** Coalesced refresh — safe to call often. */
	schedule(): void {
		if (this.rafHandle) return;
		this.rafHandle = window.requestAnimationFrame(() => {
			this.rafHandle = 0;
			void this.refresh();
		});
	}

	async refresh(): Promise<void> {
		const unread = this.controller.unreadPaths();
		const counts = this.settings().showFolderCounts ? this.controller.folderCounts() : new Map<string, number>();
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const view = await this.resolveView(leaf);
			if (!view?.fileItems) continue;
			this.observe(view.containerEl);
			for (const [path, item] of Object.entries(view.fileItems)) {
				const el = item?.selfEl;
				if (!el) continue;
				if (el.classList.contains("nav-folder-title")) {
					const count = counts.get(path);
					el.classList.toggle(FOLDER_CLASS, !!count);
					if (count) el.setAttribute(COUNT_ATTR, String(count));
					else el.removeAttribute(COUNT_ATTR);
				} else {
					el.classList.toggle(FILE_CLASS, unread.has(path));
				}
			}
		}
	}

	private async resolveView(leaf: WorkspaceLeaf): Promise<FileExplorerView | null> {
		if (requireApiVersion("1.7.2")) {
			const deferred = leaf as unknown as { loadIfDeferred?: () => Promise<void> };
			if (deferred.loadIfDeferred) await deferred.loadIfDeferred();
		}
		const view = leaf.view as FileExplorerView | undefined;
		return view && "fileItems" in view ? view : null;
	}

	/** Re-apply after Obsidian rebuilds explorer rows (collapse/expand/scroll bursts). */
	private observe(containerEl: HTMLElement): void {
		if (this.observedContainers.has(containerEl)) return;
		this.observedContainers.add(containerEl);
		const observer = new MutationObserver(() => this.schedule());
		observer.observe(containerEl, { childList: true, subtree: true });
		this.observers.push(observer);
	}

	destroy(): void {
		if (this.rafHandle) window.cancelAnimationFrame(this.rafHandle);
		for (const observer of this.observers) observer.disconnect();
		this.observers = [];
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const view = leaf.view as FileExplorerView | undefined;
			if (!view || !("fileItems" in view)) continue;
			for (const item of Object.values(view.fileItems)) {
				item?.selfEl?.classList.remove(FILE_CLASS, FOLDER_CLASS);
				item?.selfEl?.removeAttribute(COUNT_ATTR);
			}
		}
	}
}
