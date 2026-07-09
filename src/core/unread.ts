import type { MergedState, UnreadInfo } from "./types";

/**
 * Decide which notes are unread.
 * A note is unread iff:
 *  - it has no read record anywhere ("new"), or
 *  - its current hash differs from the latest read hash ("changed"), or
 *  - the latest explicit mark-unread is newer than the latest read ("marked").
 * Paths under any excluded folder are never unread.
 */
export function computeUnread(
	files: Array<{ path: string; hash: string }>,
	merged: MergedState,
	excludedFolders: string[],
): UnreadInfo[] {
	const out: UnreadInfo[] = [];
	for (const { path, hash } of files) {
		if (isExcluded(path, excludedFolders)) continue;
		const read = merged.reads[path];
		const markedAt = merged.unreadMarks[path];
		if (!read) {
			out.push({ path, reason: "new", hash });
		} else if (markedAt !== undefined && markedAt > read.readAt) {
			out.push({ path, reason: "marked", hash });
		} else if (read.hash !== hash) {
			out.push({ path, reason: "changed", hash });
		}
	}
	return out;
}

export function isExcluded(path: string, excludedFolders: string[]): boolean {
	return excludedFolders.some((folder) => path.startsWith(folder + "/"));
}

/** All ancestor folder paths of a file path, for badge rollups. */
export function ancestorsOf(path: string): string[] {
	const ancestors: string[] = [];
	let idx = path.indexOf("/");
	while (idx !== -1) {
		ancestors.push(path.slice(0, idx));
		idx = path.indexOf("/", idx + 1);
	}
	return ancestors;
}

/** Count unread per folder (including nested), for folder badges. */
export function folderUnreadCounts(unreadPaths: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const path of unreadPaths) {
		for (const folder of ancestorsOf(path)) {
			counts.set(folder, (counts.get(folder) ?? 0) + 1);
		}
	}
	return counts;
}
