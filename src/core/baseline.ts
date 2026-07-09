import type { Baseline, BaselineDiff, FileStatLike } from "./types";

/**
 * Compare current vault stats against the persisted baseline.
 * Uses INEQUALITY (never ">") — sync tools move mtimes backwards.
 */
export function diffBaseline(current: FileStatLike[], baseline: Baseline): BaselineDiff {
	const unchanged = new Map<string, string>();
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (const { path, mtime, size } of current) {
		seen.add(path);
		const entry = baseline[path];
		if (entry && entry.mtime === mtime && entry.size === size) {
			unchanged.set(path, entry.hash);
		} else {
			candidates.push(path);
		}
	}
	const deleted = Object.keys(baseline).filter((path) => !seen.has(path));
	return { unchanged, candidates, deleted };
}
