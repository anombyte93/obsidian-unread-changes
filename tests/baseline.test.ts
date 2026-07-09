import { describe, expect, test } from "vitest";
import { diffBaseline } from "../src/core/baseline";

describe("diffBaseline", () => {
	const baseline = {
		"same.md": { mtime: 1000, size: 10, hash: "sha256:same" },
		"older-mtime.md": { mtime: 5000, size: 20, hash: "sha256:om" },
		"gone.md": { mtime: 1000, size: 5, hash: "sha256:gone" },
	};

	test("classifies unchanged, changed (including backwards mtime), new, and deleted", () => {
		const out = diffBaseline(
			[
				{ path: "same.md", mtime: 1000, size: 10 },
				// mtime moved BACKWARDS — must still be a candidate (inequality, not >)
				{ path: "older-mtime.md", mtime: 4000, size: 20 },
				{ path: "brand-new.md", mtime: 9000, size: 1 },
			],
			baseline,
		);
		expect(out.unchanged.get("same.md")).toBe("sha256:same");
		expect(out.candidates.sort()).toEqual(["brand-new.md", "older-mtime.md"]);
		expect(out.deleted).toEqual(["gone.md"]);
	});

	test("size-only change is a candidate", () => {
		const out = diffBaseline([{ path: "same.md", mtime: 1000, size: 11 }], { "same.md": baseline["same.md"] });
		expect(out.candidates).toEqual(["same.md"]);
	});

	test("empty baseline makes everything a candidate", () => {
		const out = diffBaseline([{ path: "a.md", mtime: 1, size: 1 }], {});
		expect(out.candidates).toEqual(["a.md"]);
		expect(out.deleted).toEqual([]);
	});
});
