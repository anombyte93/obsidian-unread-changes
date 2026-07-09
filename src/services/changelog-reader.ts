import { TFile, Vault } from "obsidian";
import { changelogPathFor, entriesSince, parseChangelog } from "../core/changelog";
import type { ChangelogEntry } from "../core/types";

interface CacheItem {
	mtime: number;
	entries: ChangelogEntry[];
}

/** Reads `_changelog/<note>.md` sidecar notes to power attribution + summaries. */
export class ChangelogReader {
	private cache = new Map<string, CacheItem>();

	constructor(
		private vault: Vault,
		private changelogFolder: () => string,
	) {}

	changelogFile(notePath: string): TFile | null {
		const file = this.vault.getAbstractFileByPath(changelogPathFor(notePath, this.changelogFolder()));
		return file instanceof TFile ? file : null;
	}

	/** All entries for a note, newest first. Empty if no changelog exists. */
	async entriesFor(notePath: string): Promise<ChangelogEntry[]> {
		const file = this.changelogFile(notePath);
		if (!file) return [];
		const cached = this.cache.get(notePath);
		if (cached && cached.mtime === file.stat.mtime) return cached.entries;
		let entries: ChangelogEntry[] = [];
		try {
			entries = parseChangelog(await this.vault.cachedRead(file));
			entries.sort((a, b) => b.at - a.at);
		} catch {
			// unreadable changelog — treat as absent
		}
		this.cache.set(notePath, { mtime: file.stat.mtime, entries });
		return entries;
	}

	/** Newest entry strictly newer than `sinceMs` (0 = newest overall). */
	async latestFor(notePath: string, sinceMs: number): Promise<ChangelogEntry | null> {
		const entries = entriesSince(await this.entriesFor(notePath), sinceMs);
		return entries[0] ?? null;
	}

	invalidate(notePath: string): void {
		this.cache.delete(notePath);
	}

	clear(): void {
		this.cache.clear();
	}
}
