/**
 * Minimal promise-wrapped IndexedDB key-value store (replaces localforage:
 * its bundled setImmediate polyfill dynamically creates <script> elements,
 * which store review flags as code-injection risk).
 */
export class IdbKV {
	private dbPromise: Promise<IDBDatabase> | null = null;

	constructor(
		private dbName: string,
		private storeNames: readonly string[],
	) {}

	private open(): Promise<IDBDatabase> {
		this.dbPromise ??= new Promise((resolve, reject) => {
			const req = indexedDB.open(this.dbName, 1);
			req.onupgradeneeded = () => {
				for (const name of this.storeNames) {
					if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
			req.onblocked = () => reject(new Error("IndexedDB open blocked"));
		});
		return this.dbPromise;
	}

	private async run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
		const db = await this.open();
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction(store, mode);
			const req = op(tx.objectStore(store));
			req.onsuccess = () => resolve(req.result as T);
			req.onerror = () => reject(req.error ?? new Error("IndexedDB operation failed"));
		});
	}

	async get<T>(store: string, key: string): Promise<T | null> {
		const value = await this.run<T | undefined>(store, "readonly", (s) => s.get(key));
		return value ?? null;
	}

	async set(store: string, key: string, value: unknown): Promise<void> {
		await this.run(store, "readwrite", (s) => s.put(value, key));
	}

	async delete(store: string, key: string): Promise<void> {
		await this.run(store, "readwrite", (s) => s.delete(key));
	}
}
