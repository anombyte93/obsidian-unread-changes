/** A single "this device read this note-version" event. */
export interface ReadEvent {
	/** epoch ms when the note was read */
	readAt: number;
	/** content hash of the note at read time, e.g. "sha256:ab12…" */
	hash: string;
}

/** Per-device synced state file (`_unread/state/<deviceId>.json`). One writer: its device. */
export interface DeviceState {
	version: 1;
	deviceId: string;
	deviceName: string;
	/** latest read event per note path */
	notes: Record<string, ReadEvent>;
	/** explicit mark-unread overrides: path → epoch ms when marked */
	unread: Record<string, number>;
}

/** Cross-device merged view: latest read + latest unread-mark per path. */
export interface MergedState {
	reads: Record<string, ReadEvent>;
	unreadMarks: Record<string, number>;
}

/** Local (never synced) per-file scan cache. */
export interface BaselineEntry {
	mtime: number;
	size: number;
	hash: string;
}

export type Baseline = Record<string, BaselineEntry>;

export interface FileStatLike {
	path: string;
	mtime: number;
	size: number;
}

export interface BaselineDiff {
	/** stat unchanged — cached hash is trusted */
	unchanged: Map<string, string>;
	/** stat differs or path unknown — needs re-hash */
	candidates: string[];
	/** in baseline but no longer on disk */
	deleted: string[];
}

export type UnreadReason = "new" | "changed" | "marked";

export interface UnreadInfo {
	path: string;
	reason: UnreadReason;
	/** current content hash */
	hash: string;
}

/** One parsed changelog entry for a note. */
export interface ChangelogEntry {
	/** ISO 8601 timestamp string as written */
	timestamp: string;
	/** epoch ms parsed from timestamp */
	at: number;
	author: string;
	/** e.g. "agent", "human", "automation" */
	role: string;
	summary: string;
	/** unified diff body if present (without the fences) */
	diff?: string;
}
