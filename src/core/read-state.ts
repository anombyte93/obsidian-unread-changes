import type { DeviceState, MergedState } from "./types";

export function emptyDeviceState(deviceId: string, deviceName: string): DeviceState {
	return { version: 1, deviceId, deviceName, notes: {}, unread: {} };
}

/**
 * Merge all devices' state files into one view.
 * Newest wins per path; ties broken by deviceId sort order for determinism.
 */
export function mergeDeviceStates(states: DeviceState[]): MergedState {
	const sorted = [...states].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
	const merged: MergedState = { reads: {}, unreadMarks: {} };
	for (const state of sorted) {
		for (const [path, event] of Object.entries(state.notes)) {
			const existing = merged.reads[path];
			if (!existing || event.readAt > existing.readAt) merged.reads[path] = event;
		}
		for (const [path, at] of Object.entries(state.unread)) {
			const existing = merged.unreadMarks[path];
			if (existing === undefined || at > existing) merged.unreadMarks[path] = at;
		}
	}
	return merged;
}

/** Record a read on this device (returns a new state object). */
export function recordRead(
	state: DeviceState,
	path: string,
	hash: string,
	readAt: number,
): DeviceState {
	const unread = { ...state.unread };
	delete unread[path];
	return {
		...state,
		notes: { ...state.notes, [path]: { readAt, hash } },
		unread,
	};
}

/** Explicitly mark a note unread on this device (returns a new state object). */
export function recordMarkUnread(state: DeviceState, path: string, at: number): DeviceState {
	return { ...state, unread: { ...state.unread, [path]: at } };
}

/** Transfer state across a rename (returns a new state object). */
export function renamePath(state: DeviceState, oldPath: string, newPath: string): DeviceState {
	const notes = { ...state.notes };
	const unread = { ...state.unread };
	const read = notes[oldPath];
	if (read !== undefined) {
		delete notes[oldPath];
		notes[newPath] = read;
	}
	const mark = unread[oldPath];
	if (mark !== undefined) {
		delete unread[oldPath];
		unread[newPath] = mark;
	}
	return { ...state, notes, unread };
}

/** Drop state for a deleted note (returns a new state object). */
export function removePath(state: DeviceState, path: string): DeviceState {
	const notes = { ...state.notes };
	const unread = { ...state.unread };
	delete notes[path];
	delete unread[path];
	return { ...state, notes, unread };
}

/** Parse + validate a device state JSON string; null if unusable. */
export function parseDeviceState(json: string): DeviceState | null {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (obj.version !== 1) return null;
	if (typeof obj.deviceId !== "string" || typeof obj.deviceName !== "string") return null;
	if (typeof obj.notes !== "object" || obj.notes === null) return null;
	const notes: DeviceState["notes"] = {};
	for (const [path, ev] of Object.entries(obj.notes as Record<string, unknown>)) {
		if (typeof ev !== "object" || ev === null) return null;
		const { readAt, hash } = ev as Record<string, unknown>;
		if (typeof readAt !== "number" || typeof hash !== "string") return null;
		notes[path] = { readAt, hash };
	}
	const unread: DeviceState["unread"] = {};
	if (obj.unread !== undefined) {
		if (typeof obj.unread !== "object" || obj.unread === null) return null;
		for (const [path, at] of Object.entries(obj.unread as Record<string, unknown>)) {
			if (typeof at !== "number") return null;
			unread[path] = at;
		}
	}
	return { version: 1, deviceId: obj.deviceId, deviceName: obj.deviceName, notes, unread };
}
