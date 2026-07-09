import { describe, expect, test } from "vitest";
import { ancestorsOf, computeUnread, folderUnreadCounts, isExcluded } from "../src/core/unread";
import type { MergedState } from "../src/core/types";

const merged = (reads: MergedState["reads"] = {}, unreadMarks: MergedState["unreadMarks"] = {}): MergedState => ({
	reads,
	unreadMarks,
});

describe("computeUnread", () => {
	test("note with no read record anywhere is unread as 'new'", () => {
		const out = computeUnread([{ path: "a.md", hash: "sha256:aa" }], merged(), []);
		expect(out).toEqual([{ path: "a.md", reason: "new", hash: "sha256:aa" }]);
	});

	test("note whose hash matches its latest read is read", () => {
		const out = computeUnread(
			[{ path: "a.md", hash: "sha256:aa" }],
			merged({ "a.md": { readAt: 100, hash: "sha256:aa" } }),
			[],
		);
		expect(out).toEqual([]);
	});

	test("note whose content changed since last read is unread as 'changed'", () => {
		const out = computeUnread(
			[{ path: "a.md", hash: "sha256:NEW" }],
			merged({ "a.md": { readAt: 100, hash: "sha256:aa" } }),
			[],
		);
		expect(out).toEqual([{ path: "a.md", reason: "changed", hash: "sha256:NEW" }]);
	});

	test("explicit unread mark newer than the read wins even when hashes match", () => {
		const out = computeUnread(
			[{ path: "a.md", hash: "sha256:aa" }],
			merged({ "a.md": { readAt: 100, hash: "sha256:aa" } }, { "a.md": 200 }),
			[],
		);
		expect(out).toEqual([{ path: "a.md", reason: "marked", hash: "sha256:aa" }]);
	});

	test("a read newer than the unread mark clears it", () => {
		const out = computeUnread(
			[{ path: "a.md", hash: "sha256:aa" }],
			merged({ "a.md": { readAt: 300, hash: "sha256:aa" } }, { "a.md": 200 }),
			[],
		);
		expect(out).toEqual([]);
	});

	test("excluded folders never produce unread entries", () => {
		const out = computeUnread(
			[
				{ path: "_changelog/a.md", hash: "sha256:x" },
				{ path: "Screenshots/pic.md", hash: "sha256:y" },
				{ path: "real.md", hash: "sha256:z" },
			],
			merged(),
			["_changelog", "Screenshots"],
		);
		expect(out.map((u) => u.path)).toEqual(["real.md"]);
	});
});

describe("isExcluded", () => {
	test("matches folder prefix on path-segment boundaries only", () => {
		expect(isExcluded("_changelog/a.md", ["_changelog"])).toBe(true);
		expect(isExcluded("_changelog_extra/a.md", ["_changelog"])).toBe(false);
		expect(isExcluded("deep/_changelog/a.md", ["_changelog"])).toBe(false);
		expect(isExcluded("a.md", [])).toBe(false);
	});
});

describe("ancestorsOf", () => {
	test("returns every ancestor folder, deepest last", () => {
		expect(ancestorsOf("a/b/c/note.md")).toEqual(["a", "a/b", "a/b/c"]);
		expect(ancestorsOf("note.md")).toEqual([]);
	});
});

describe("folderUnreadCounts", () => {
	test("counts roll up through all ancestors", () => {
		const counts = folderUnreadCounts(["a/b/x.md", "a/b/y.md", "a/z.md", "root.md"]);
		expect(counts.get("a")).toBe(3);
		expect(counts.get("a/b")).toBe(2);
		expect(counts.has("")).toBe(false);
	});
});
