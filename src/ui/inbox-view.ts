import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { UnreadController } from "../controller";
import { timeAgo } from "./format";

export const INBOX_VIEW_TYPE = "unread-changes-inbox";

const REASON_LABEL: Record<string, string> = {
	new: "new note",
	changed: "changed",
	marked: "marked unread",
};

/** Right-sidebar inbox: every unread note, newest change first, with attribution. */
export class InboxView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	/** redraw is async (changelog reads) — stale generations must abort, not interleave */
	private redrawGeneration = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private controller: UnreadController,
	) {
		super(leaf);
	}

	getViewType(): string {
		return INBOX_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Unread changes";
	}

	getIcon(): string {
		return "inbox";
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.controller.onChange(() => void this.redraw());
		await this.redraw();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private async redraw(): Promise<void> {
		const generation = ++this.redrawGeneration;
		const container = this.contentEl;

		const unread = this.controller.getUnread();
		const rows = unread
			.map((info) => {
				const file = this.app.vault.getAbstractFileByPath(info.path);
				return { info, file: file instanceof TFile ? file : null };
			})
			.filter((r) => r.file !== null)
			.sort((a, b) => (b.file?.stat.mtime ?? 0) - (a.file?.stat.mtime ?? 0));

		// resolve attribution BEFORE touching the DOM, checking staleness after each await
		const resolved = [];
		for (const { info, file } of rows) {
			const entry =
				(await this.controller.changelogReader.latestFor(info.path, this.controller.lastReadAt(info.path))) ??
				(await this.controller.changelogReader.latestFor(info.path, 0));
			if (generation !== this.redrawGeneration) return; // superseded — abort
			resolved.push({ info, file: file!, entry });
		}

		container.empty();
		if (resolved.length === 0) {
			container.createDiv({ cls: "uc-inbox-empty", text: "All caught up — no unread changes." });
			return;
		}

		for (const { info, file, entry } of resolved) {
			const item = container.createDiv({ cls: "uc-inbox-item" });
			item.createDiv({ cls: "uc-inbox-title", text: file.basename });

			const who = entry
				? `${entry.author} · ${timeAgo(entry.at)}`
				: `${REASON_LABEL[info.reason] ?? info.reason} · ${timeAgo(file.stat.mtime)}`;
			const folder = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path} · ` : "";
			item.createDiv({ cls: "uc-inbox-meta", text: `${folder}${who}` });
			if (entry?.summary) item.createDiv({ cls: "uc-inbox-summary", text: entry.summary });

			item.addEventListener("click", (event) => {
				void this.app.workspace.getLeaf(event.ctrlKey || event.metaKey).openFile(file);
			});
		}
	}
}
