import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import { parseDeviceState } from "../core/read-state";
import type { DeviceState } from "../core/types";

/**
 * Reads/writes the per-device read-state files in the (synced) vault.
 * Invariant: this device only ever writes `<stateFolder>/<ownDeviceId>.json`;
 * every other device's file is read-only for us.
 */
export class StateSync {
	/** paths of our own writes still expected to echo back as vault events */
	private pendingOwnWrites = new Set<string>();

	constructor(
		private vault: Vault,
		private stateFolder: () => string,
		private ownDeviceId: string,
	) {}

	ownStatePath(): string {
		return normalizePath(`${this.stateFolder()}/${this.ownDeviceId}.json`);
	}

	isStateFile(path: string): boolean {
		return path.startsWith(this.stateFolder() + "/") && path.endsWith(".json");
	}

	isOwnStateFile(path: string): boolean {
		return path === this.ownStatePath();
	}

	/** True while a vault event for `path` is the echo of our own write. */
	consumeOwnWriteEcho(path: string): boolean {
		return this.pendingOwnWrites.delete(path);
	}

	/** Load every device state file in the state folder (own + others). */
	async loadAll(): Promise<DeviceState[]> {
		const folder = this.vault.getAbstractFileByPath(normalizePath(this.stateFolder()));
		if (!(folder instanceof TFolder)) return [];
		const states: DeviceState[] = [];
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "json") continue;
			try {
				const state = parseDeviceState(await this.vault.cachedRead(child));
				if (state) states.push(state);
			} catch {
				// unreadable state file — skip; it will be retried next scan
			}
		}
		return states;
	}

	/** Load one device state file by path (e.g. after a sync event). */
	async loadOne(path: string): Promise<DeviceState | null> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		try {
			return parseDeviceState(await this.vault.cachedRead(file));
		} catch {
			return null;
		}
	}

	/** Persist our own device state (creates folders on demand). */
	async writeOwn(state: DeviceState): Promise<void> {
		const path = this.ownStatePath();
		const json = JSON.stringify(state, null, 1);
		const existing = this.vault.getAbstractFileByPath(path);
		this.pendingOwnWrites.add(path);
		if (existing instanceof TFile) {
			await this.vault.modify(existing, json);
		} else {
			await this.ensureFolder(this.stateFolder());
			await this.vault.create(path, json);
		}
		// Failsafe: don't let a missed echo suppress a real future event.
		window.setTimeout(() => this.pendingOwnWrites.delete(path), 5000);
	}

	/** Move a note's changelog sidecar when the note is renamed (keeps linkage). */
	async renameChangelog(oldNotePath: string, newNotePath: string, changelogFolder: string): Promise<void> {
		const oldFile = this.vault.getAbstractFileByPath(normalizePath(`${changelogFolder}/${oldNotePath}`));
		if (!(oldFile instanceof TFile)) return;
		const newPath = normalizePath(`${changelogFolder}/${newNotePath}`);
		try {
			const parent = newPath.split("/").slice(0, -1).join("/");
			if (parent) await this.ensureFolder(parent);
			await this.vault.rename(oldFile, newPath);
		} catch (e) {
			console.error("unread-changes: failed to move changelog sidecar", e);
		}
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const full = normalizePath(folderPath);
		if (this.vault.getAbstractFileByPath(full)) return;
		try {
			await this.vault.createFolder(full); // recursive on desktop and mobile adapters
			return;
		} catch {
			// fall through to segment-by-segment for adapters that raced or aren't recursive
		}
		const parts = full.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				try {
					await this.vault.createFolder(current);
				} catch {
					// raced with another creator — fine
				}
			}
		}
	}
}
