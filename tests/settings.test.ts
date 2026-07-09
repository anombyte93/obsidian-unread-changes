import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, effectiveExclusions } from "../src/settings";

describe("effectiveExclusions", () => {
	test("excludes the exact configured folders, not their first path segment", () => {
		const out = effectiveExclusions({
			...DEFAULT_SETTINGS,
			stateFolder: "Work/_unread/state",
			changelogFolder: "Work/_changelog",
		});
		expect(out.sort()).toEqual(["Work/_changelog", "Work/_unread/state"]);
		// crucially, "Work" itself must NOT be excluded
		expect(out).not.toContain("Work");
	});

	test("defaults exclude the state and changelog folders", () => {
		expect(effectiveExclusions(DEFAULT_SETTINGS).sort()).toEqual(["_changelog", "_unread/state"]);
	});

	test("user extras are normalized (trailing slashes stripped, blanks dropped)", () => {
		const out = effectiveExclusions({
			...DEFAULT_SETTINGS,
			excludedFolders: ["Screenshots/", "  ", "Archive"],
		});
		expect(out).toContain("Screenshots");
		expect(out).toContain("Archive");
		expect(out).toHaveLength(4);
	});
});
