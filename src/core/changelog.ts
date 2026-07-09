import type { ChangelogEntry } from "./types";

/** Vault path of the changelog note for a given note. */
export function changelogPathFor(notePath: string, changelogFolder: string): string {
	return `${changelogFolder}/${notePath}`;
}

/** Inverse of changelogPathFor; null if not under the changelog folder. */
export function notePathFor(changelogPath: string, changelogFolder: string): string | null {
	const prefix = changelogFolder + "/";
	return changelogPath.startsWith(prefix) ? changelogPath.slice(prefix.length) : null;
}

const HEADING = /^## (\S[^—]*?) — (.+?) · (.+?)\s*$/;
const SUMMARY = /^\*\*Summary:\*\* (.*)$/;

/**
 * Parse a changelog note into entries (file order, newest first by convention).
 * Entry headings: `## <ISO timestamp> — <author> · <role>`.
 * A fenced ```diff block inside a <details> is captured as the entry diff.
 * Heading detection is fence-aware: `## ` lines inside code fences are content.
 */
export function parseChangelog(content: string): ChangelogEntry[] {
	const entries: ChangelogEntry[] = [];
	let current: ChangelogEntry | null = null;
	let inFence = false;
	let inDiffFence = false;
	let diffLines: string[] | null = null;

	const closeDiff = () => {
		if (current && diffLines) current.diff = diffLines.join("\n");
		diffLines = null;
		inDiffFence = false;
	};

	for (const line of content.split("\n")) {
		if (line.startsWith("```")) {
			if (inDiffFence) {
				closeDiff();
			} else if (!inFence && line.startsWith("```diff") && current && current.diff === undefined) {
				inDiffFence = true;
				diffLines = [];
			} else {
				inFence = !inFence;
			}
			continue;
		}
		if (inDiffFence && diffLines) {
			diffLines.push(line);
			continue;
		}
		if (inFence) continue;

		const heading = HEADING.exec(line);
		if (heading) {
			const [, timestamp, author, role] = heading;
			const at = Date.parse(timestamp!.trim());
			if (!Number.isNaN(at)) {
				current = { timestamp: timestamp!.trim(), at, author: author!, role: role!, summary: "" };
				entries.push(current);
			}
			continue;
		}
		if (current && current.summary === "") {
			const summary = SUMMARY.exec(line);
			if (summary) current.summary = summary[1]!;
		}
	}
	closeDiff();
	return entries;
}

/** Render one entry in the canonical format (shared with vault_write.py). */
export function formatEntry(entry: ChangelogEntry): string {
	let out = `## ${entry.timestamp} — ${entry.author} · ${entry.role}\n`;
	out += `**Summary:** ${entry.summary}\n`;
	if (entry.diff !== undefined) {
		out += `\n<details><summary>Diff</summary>\n\n\`\`\`diff\n${entry.diff}\n\`\`\`\n\n</details>\n`;
	}
	return out;
}

/** Entries strictly newer than `sinceMs` (0 = all). */
export function entriesSince(entries: ChangelogEntry[], sinceMs: number): ChangelogEntry[] {
	return entries.filter((entry) => entry.at > sinceMs);
}
