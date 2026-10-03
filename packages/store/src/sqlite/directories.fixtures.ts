import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteMailStoreOptions } from './options';
import { SqliteMailStore } from './store';

/**
 * Temporary directories for a spec file, and the stores opened in them:
 * every store is closed and every directory removed once the file's specs
 * have run.
 */
export function temporaryStores() {
	const directories: string[] = [];
	const stores: SqliteMailStore[] = [];
	afterAll(() => {
		for (const store of stores) store.close();
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	const directory = () => {
		const made = mkdtempSync(join(tmpdir(), 'bumail-sqlite-'));
		directories.push(made);
		return made;
	};
	const open = (
		at = directory(),
		options: Omit<SqliteMailStoreOptions, 'directory'> = {},
	) => {
		const store = SqliteMailStore.open({ ...options, directory: at });
		stores.push(store);
		return store;
	};
	return { directory, open };
}
