import { App, Modal, TFile } from "obsidian";
import { diffLines } from "diff";
import type { UnreadController } from "../controller";
import type { LocalStore } from "../services/local-store";

/**
 * Shows what changed in a note: current content vs the snapshot taken when it
 * was last read on this device; falls back to the newest changelog diff.
 */
export class DiffModal extends Modal {
	constructor(
		app: App,
		private controller: UnreadController,
		private store: LocalStore,
		private path: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(`Changes — ${this.path.split("/").pop() ?? this.path}`);
		const body = this.contentEl.createDiv({ cls: "uc-diff-modal" });

		const file = this.app.vault.getAbstractFileByPath(this.path);
		if (!(file instanceof TFile)) {
			body.setText("Note not found.");
			return;
		}
		const current = await this.app.vault.cachedRead(file);
		const snapshot = await this.store.getSnapshot(this.path);

		if (snapshot) {
			body.createEl("p", { cls: "uc-diff-context", text: "Compared to the version you last read on this device:" });
			this.renderDiff(body, snapshot.content, current);
			return;
		}

		const entry = await this.controller.changelogReader.latestFor(this.path, 0);
		if (entry?.diff) {
			body.createEl("p", { cls: "uc-diff-context", text: `Latest changelog diff (${entry.author}, ${entry.timestamp}):` });
			const pre = body.createEl("pre");
			pre.createEl("code", { text: entry.diff });
			return;
		}

		body.setText("No earlier version available yet — diffs appear once the note has been read on this device or has a changelog entry.");
	}

	private renderDiff(body: HTMLElement, before: string, after: string): void {
		if (before === after) {
			body.createEl("p", { text: "Content is identical to the version you last read." });
			return;
		}
		const pre = body.createEl("pre");
		for (const part of diffLines(before, after)) {
			const cls = part.added ? "uc-diff-added" : part.removed ? "uc-diff-removed" : "uc-diff-context";
			// collapse long unchanged runs to keep the modal scannable
			let text = part.value;
			if (!part.added && !part.removed) {
				const lines = text.split("\n");
				if (lines.length > 8) {
					text = [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)].join("\n");
				}
			}
			pre.createSpan({ cls, text });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
