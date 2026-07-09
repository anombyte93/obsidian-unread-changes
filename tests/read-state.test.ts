import { describe, expect, test } from "vitest";
import {
	emptyDeviceState,
	mergeDeviceStates,
	parseDeviceState,
	recordMarkUnread,
	recordRead,
	removePath,
	renamePath,
} from "../src/core/read-state";
import type { DeviceState } from "../src/core/types";

function dev(id: string, notes: DeviceState["notes"] = {}, unread: DeviceState["unread"] = {}): DeviceState {
	return { version: 1, deviceId: id, deviceName: id, notes, unread };
}

describe("emptyDeviceState", () => {
	test("creates a valid empty state", () => {
		const s = emptyDeviceState("d-1", "Hayden-desktop");
		expect(s).toEqual({
			version: 1,
			deviceId: "d-1",
			deviceName: "Hayden-desktop",
			notes: {},
			unread: {},
		});
	});
});

describe("recordRead", () => {
	test("adds a read event without mutating the original", () => {
		const s0 = dev("d-1");
		const s1 = recordRead(s0, "a.md", "sha256:aa", 1000);
		expect(s1.notes["a.md"]).toEqual({ readAt: 1000, hash: "sha256:aa" });
		expect(s0.notes["a.md"]).toBeUndefined();
	});

	test("replaces an older read for the same path", () => {
		const s = recordRead(recordRead(dev("d-1"), "a.md", "sha256:aa", 1000), "a.md", "sha256:bb", 2000);
		expect(s.notes["a.md"]).toEqual({ readAt: 2000, hash: "sha256:bb" });
	});

	test("clears an explicit unread mark for that path", () => {
		const marked = recordMarkUnread(dev("d-1", { "a.md": { readAt: 1000, hash: "sha256:aa" } }), "a.md", 1500);
		const s = recordRead(marked, "a.md", "sha256:aa", 2000);
		expect(s.unread["a.md"]).toBeUndefined();
	});
});

describe("recordMarkUnread", () => {
	test("stores the mark without mutating", () => {
		const s0 = dev("d-1");
		const s1 = recordMarkUnread(s0, "a.md", 1234);
		expect(s1.unread["a.md"]).toBe(1234);
		expect(s0.unread["a.md"]).toBeUndefined();
	});
});

describe("renamePath / removePath", () => {
	test("rename transfers read event and unread mark", () => {
		const s0 = dev("d-1", { "a.md": { readAt: 1, hash: "sha256:aa" } }, { "a.md": 5 });
		const s1 = renamePath(s0, "a.md", "b/c.md");
		expect(s1.notes["a.md"]).toBeUndefined();
		expect(s1.notes["b/c.md"]).toEqual({ readAt: 1, hash: "sha256:aa" });
		expect(s1.unread["a.md"]).toBeUndefined();
		expect(s1.unread["b/c.md"]).toBe(5);
	});

	test("rename of unknown path is a no-op", () => {
		const s0 = dev("d-1", { "a.md": { readAt: 1, hash: "sha256:aa" } });
		expect(renamePath(s0, "zzz.md", "y.md")).toEqual(s0);
	});

	test("remove drops both maps", () => {
		const s0 = dev("d-1", { "a.md": { readAt: 1, hash: "sha256:aa" } }, { "a.md": 5 });
		const s1 = removePath(s0, "a.md");
		expect(s1.notes["a.md"]).toBeUndefined();
		expect(s1.unread["a.md"]).toBeUndefined();
	});
});

describe("mergeDeviceStates", () => {
	test("union across devices", () => {
		const merged = mergeDeviceStates([
			dev("d-1", { "a.md": { readAt: 100, hash: "sha256:aa" } }),
			dev("d-2", { "b.md": { readAt: 200, hash: "sha256:bb" } }),
		]);
		expect(merged.reads["a.md"]).toEqual({ readAt: 100, hash: "sha256:aa" });
		expect(merged.reads["b.md"]).toEqual({ readAt: 200, hash: "sha256:bb" });
	});

	test("newest read wins per path", () => {
		const merged = mergeDeviceStates([
			dev("d-1", { "a.md": { readAt: 100, hash: "sha256:old" } }),
			dev("d-2", { "a.md": { readAt: 300, hash: "sha256:new" } }),
		]);
		expect(merged.reads["a.md"]).toEqual({ readAt: 300, hash: "sha256:new" });
	});

	test("equal timestamps resolve deterministically regardless of input order", () => {
		const a = dev("d-1", { "a.md": { readAt: 100, hash: "sha256:from1" } });
		const b = dev("d-2", { "a.md": { readAt: 100, hash: "sha256:from2" } });
		expect(mergeDeviceStates([a, b])).toEqual(mergeDeviceStates([b, a]));
	});

	test("newest unread mark survives merge", () => {
		const merged = mergeDeviceStates([
			dev("d-1", {}, { "a.md": 100 }),
			dev("d-2", {}, { "a.md": 250 }),
		]);
		expect(merged.unreadMarks["a.md"]).toBe(250);
	});

	test("empty input merges to empty state", () => {
		expect(mergeDeviceStates([])).toEqual({ reads: {}, unreadMarks: {} });
	});
});

describe("parseDeviceState", () => {
	test("round-trips a valid state", () => {
		const s = dev("d-1", { "a.md": { readAt: 1, hash: "sha256:aa" } }, { "b.md": 2 });
		expect(parseDeviceState(JSON.stringify(s))).toEqual(s);
	});

	test("rejects garbage, wrong versions, and malformed shapes", () => {
		expect(parseDeviceState("not json{")).toBeNull();
		expect(parseDeviceState(JSON.stringify({ version: 99, deviceId: "x", deviceName: "x", notes: {}, unread: {} }))).toBeNull();
		expect(parseDeviceState(JSON.stringify({ version: 1 }))).toBeNull();
		expect(parseDeviceState(JSON.stringify(null))).toBeNull();
	});

	test("tolerates a missing unread map from older writers", () => {
		const legacy = { version: 1, deviceId: "d", deviceName: "d", notes: {} };
		expect(parseDeviceState(JSON.stringify(legacy))).toEqual({ ...legacy, unread: {} });
	});
});
