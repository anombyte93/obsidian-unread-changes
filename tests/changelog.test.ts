import { describe, expect, test } from "vitest";
import {
	changelogPathFor,
	entriesSince,
	formatEntry,
	notePathFor,
	parseChangelog,
} from "../src/core/changelog";

describe("changelog path mapping", () => {
	test("mirrors the note tree under the changelog folder", () => {
		expect(changelogPathFor("AtlasAI/Clients/Josh/Issues.md", "_changelog")).toBe(
			"_changelog/AtlasAI/Clients/Josh/Issues.md",
		);
		expect(changelogPathFor("Top.md", "_changelog")).toBe("_changelog/Top.md");
	});

	test("notePathFor inverts changelogPathFor", () => {
		expect(notePathFor("_changelog/A/B.md", "_changelog")).toBe("A/B.md");
		expect(notePathFor("Other/A.md", "_changelog")).toBeNull();
		expect(notePathFor("_changelog_x/A.md", "_changelog")).toBeNull();
	});
});

const SAMPLE = `---
target: "AtlasAI/Clients/Josh/Issues.md"
---
## 2026-07-09T12:45:39+08:00 — claude · agent
**Summary:** Added staging UAT feedback; reprioritised the fix wave.

<details><summary>Diff</summary>

\`\`\`diff
@@ -1,3 +1,4 @@
 # Issues
+## New section heading that looks like an entry
-old line
+new line
\`\`\`

</details>

## 2026-07-08T09:00:00+08:00 — Hayden (iPhone) · human
**Summary:** Manual edit on phone.
`;

describe("parseChangelog", () => {
	test("parses entries with author, role, timestamp, summary", () => {
		const entries = parseChangelog(SAMPLE);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			timestamp: "2026-07-09T12:45:39+08:00",
			author: "claude",
			role: "agent",
			summary: "Added staging UAT feedback; reprioritised the fix wave.",
		});
		expect(entries[0]!.at).toBe(Date.parse("2026-07-09T12:45:39+08:00"));
		expect(entries[1]).toMatchObject({ author: "Hayden (iPhone)", role: "human" });
	});

	test("captures the diff body and is not fooled by ## lines inside fences", () => {
		const entries = parseChangelog(SAMPLE);
		expect(entries[0]!.diff).toContain("+## New section heading that looks like an entry");
		expect(entries[0]!.diff).toContain("+new line");
		expect(entries[1]!.diff).toBeUndefined();
	});

	test("returns empty for content without entries", () => {
		expect(parseChangelog("just some text\n## not an entry heading\n")).toEqual([]);
		expect(parseChangelog("")).toEqual([]);
	});
});

describe("formatEntry / round-trip", () => {
	test("formatEntry output parses back to the same entry", () => {
		const entry = {
			timestamp: "2026-07-09T13:00:00+08:00",
			at: Date.parse("2026-07-09T13:00:00+08:00"),
			author: "claude",
			role: "agent",
			summary: "Rewrote the intro.",
			diff: "@@ -1 +1 @@\n-a\n+b",
		};
		const [parsed] = parseChangelog(formatEntry(entry));
		expect(parsed).toEqual(entry);
	});

	test("entry without diff round-trips too", () => {
		const entry = {
			timestamp: "2026-07-09T13:00:00+08:00",
			at: Date.parse("2026-07-09T13:00:00+08:00"),
			author: "Hayden (desktop)",
			role: "human",
			summary: "Tidied headings.",
		};
		const [parsed] = parseChangelog(formatEntry(entry));
		expect(parsed).toEqual(entry);
	});
});

describe("entriesSince", () => {
	test("filters strictly newer entries", () => {
		const entries = parseChangelog(SAMPLE);
		const cutoff = Date.parse("2026-07-08T09:00:00+08:00");
		expect(entriesSince(entries, cutoff)).toHaveLength(1);
		expect(entriesSince(entries, 0)).toHaveLength(2);
	});
});
