import { describe, expect, test } from "vitest";
import { hashContent } from "../src/core/hash";

describe("hashContent", () => {
	test("produces the known sha256 for a fixed string", async () => {
		// echo -n "hello" | sha256sum
		expect(await hashContent("hello")).toBe(
			"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
	});

	test("is stable and differs across contents", async () => {
		expect(await hashContent("a")).toBe(await hashContent("a"));
		expect(await hashContent("a")).not.toBe(await hashContent("b"));
		expect(await hashContent("")).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});
