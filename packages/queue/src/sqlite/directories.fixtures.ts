import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteQueueStoreOptions } from './options';
import { SqliteQueueStore } from './store';

/**
 * Temporary directories for a spec file, and the stores opened in them:
 * every store is closed and every directory removed once the file's specs
 * have run.
 */
export function temporaryStores() {
	const directories: string[] = [];
	const stores: SqliteQueueStore[] = [];
	const where = new WeakMap<SqliteQueueStore, string>();
	afterAll(() => {
		for (const store of stores) store.close();
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	const directory = () => {
		const made = mkdtempSync(join(tmpdir(), 'bumail-queue-'));
		directories.push(made);
		return made;
	};
	const open = (
		at = directory(),
		options: Omit<SqliteQueueStoreOptions, 'directory'> = {},
	) => {
		const store = SqliteQueueStore.open({ ...options, directory: at });
		stores.push(store);
		where.set(store, at);
		return store;
	};
	/** A second store on the directory of `store`: another connection to the same database. */
	const share = (store: SqliteQueueStore) => open(where.get(store));
	return { directory, open, share };
}
