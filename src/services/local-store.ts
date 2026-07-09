import localforage from "localforage";
import type { App } from "obsidian";
import type { Baseline } from "../core/types";

export interface Snapshot {
	hash: string;
	content: string;
	takenAt: number;
}

/**
 * Per-device storage that must NEVER sync: device identity, scan baseline,
 * last-read snapshots. localStorage for the tiny device id, IndexedDB
 * (localforage) for the rest — both are per-app-install, mobile-safe.
 */
export class LocalStore {
	private baselineStore: ReturnType<typeof localforage.createInstance>;
	private snapshotStore: ReturnType<typeof localforage.createInstance>;
	private appId: string;

	constructor(app: App) {
		this.appId = ((app as unknown as { appId?: string }).appId ?? "vault").toString();
		this.baselineStore = localforage.createInstance({
			name: `unread-changes-${this.appId}`,
			storeName: "baseline",
		});
		this.snapshotStore = localforage.createInstance({
			name: `unread-changes-${this.appId}`,
			storeName: "snapshots",
		});
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
		return (await this.baselineStore.getItem<Baseline>("baseline")) ?? {};
	}

	async saveBaseline(baseline: Baseline): Promise<void> {
		await this.baselineStore.setItem("baseline", baseline);
	}

	async getSnapshot(path: string): Promise<Snapshot | null> {
		return await this.snapshotStore.getItem<Snapshot>(path);
	}

	async saveSnapshot(path: string, snapshot: Snapshot): Promise<void> {
		await this.snapshotStore.setItem(path, snapshot);
	}

	async renameSnapshot(oldPath: string, newPath: string): Promise<void> {
		const snap = await this.getSnapshot(oldPath);
		if (snap) {
			await this.snapshotStore.setItem(newPath, snap);
			await this.snapshotStore.removeItem(oldPath);
		}
	}

	async removeSnapshot(path: string): Promise<void> {
		await this.snapshotStore.removeItem(path);
	}
}
