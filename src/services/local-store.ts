import type { App } from "obsidian";
import type { Baseline } from "../core/types";
import { IdbKV } from "./idb";

export interface Snapshot {
	hash: string;
	content: string;
	takenAt: number;
}

const BASELINE = "baseline";
const SNAPSHOTS = "snapshots";

/**
 * Per-device storage that must NEVER sync: device identity, scan baseline,
 * last-read snapshots. localStorage for the tiny identity values, IndexedDB
 * for the rest — both are per-app-install and mobile-safe. (Deliberately NOT
 * the plugin data.json API: that file can sync between devices via config-dir
 * sync, which would corrupt per-device state.)
 */
export class LocalStore {
	private db: IdbKV;
	private appId: string;

	constructor(app: App) {
		this.appId = ((app as unknown as { appId?: string }).appId ?? "vault").toString();
		this.db = new IdbKV(`unread-changes-db-${this.appId}`, [BASELINE, SNAPSHOTS]);
	}

	/** Stable, collision-resistant per-install device id (never synced). */
	getDeviceId(): string {
		const key = `unread-changes-device-id:${this.appId}`;
		let id = window.localStorage.getItem(key);
		if (!id) {
			const bytes = new Uint8Array(8);
			crypto.getRandomValues(bytes);
			id = "d-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
			window.localStorage.setItem(key, id);
		}
		return id;
	}

	/** Human-readable device name — per-device, so it must NOT live in the (syncable) data.json. */
	getDeviceName(): string {
		return window.localStorage.getItem(`unread-changes-device-name:${this.appId}`) ?? "";
	}

	setDeviceName(name: string): void {
		window.localStorage.setItem(`unread-changes-device-name:${this.appId}`, name);
	}

	/** True once this install has completed its first initialize (guards re-seeding). */
	hasInitialized(): boolean {
		return window.localStorage.getItem(`unread-changes-initialized:${this.appId}`) === "1";
	}

	markInitialized(): void {
		window.localStorage.setItem(`unread-changes-initialized:${this.appId}`, "1");
	}

	async loadBaseline(): Promise<Baseline> {
		return (await this.db.get<Baseline>(BASELINE, "baseline")) ?? {};
	}

	async saveBaseline(baseline: Baseline): Promise<void> {
		await this.db.set(BASELINE, "baseline", baseline);
	}

	async getSnapshot(path: string): Promise<Snapshot | null> {
		return await this.db.get<Snapshot>(SNAPSHOTS, path);
	}

	async saveSnapshot(path: string, snapshot: Snapshot): Promise<void> {
		await this.db.set(SNAPSHOTS, path, snapshot);
	}

	async renameSnapshot(oldPath: string, newPath: string): Promise<void> {
		const snap = await this.getSnapshot(oldPath);
		if (snap) {
			await this.db.set(SNAPSHOTS, newPath, snap);
			await this.db.delete(SNAPSHOTS, oldPath);
		}
	}

	async removeSnapshot(path: string): Promise<void> {
		await this.db.delete(SNAPSHOTS, path);
	}
}
