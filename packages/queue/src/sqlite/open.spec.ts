import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import { temporaryStores } from './directories.fixtures';
import { MIGRATIONS } from './schema';
import { SqliteQueueStore } from './store';

const { directory, open } = temporaryStores();

describe('SqliteQueueStore on disk', () => {
	test('an item, its message and its lease outlive a restart', async () => {
		const at = directory();
		const first = open(at);
		const item = await first.add(entry());
		await first.claim({ owner: 'w1', now: T0, leaseMs: MINUTE });
		first.close();
		const again = open(at);
		expect((await again.get(item.id))?.lease?.owner).toBe('w1');
		expect(new TextDecoder().decode(await again.readMessage(item.id))).toBe(
			'Subject: Hi\r\n\r\nHello\r\n',
		);
	});

	test('the directory and the database are the owner’s alone', () => {
		const at = join(directory(), 'nested');
		open(at);
		expect(statSync(at).mode & 0o777).toBe(0o700);
		expect(statSync(join(at, 'queue.sqlite')).mode & 0o777).toBe(0o600);
	});

	test('a directory that already exists keeps its mode; the database is still private', () => {
		const at = directory();
		chmodSync(at, 0o750);
		open(at);
		expect(statSync(at).mode & 0o777).toBe(0o750);
		expect(statSync(join(at, 'queue.sqlite')).mode & 0o777).toBe(0o600);
	});

	test('a closed store refuses with CLOSED; closing twice is fine', async () => {
		const store = open();
		store.close();
		store.close();
		await expect(store.count()).rejects.toMatchObject({ code: 'CLOSED' });
	});

	test('open refuses a missing directory, a bad busyTimeout, and what is not a database', () => {
		expect(() => SqliteQueueStore.open({} as { directory: string })).toThrow(
			'A SQLite queue store needs a directory',
		);
		expect(() => open(undefined, { busyTimeout: -1 })).toThrow(
			'busyTimeout must be an integer of at least 0, not -1',
		);
		const at = directory();
		writeFileSync(join(at, 'queue.sqlite'), 'not a database, not at all');
		expect(() => open(at)).toThrow(`The queue at "${at}" cannot be opened`);
	});

	test('a database from a newer store is refused', () => {
		const at = directory();
		open(at).close();
		const db = new Database(join(at, 'queue.sqlite'));
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
		db.close();
		expect(() => open(at)).toThrow(
			`The database is at schema version ${MIGRATIONS.length + 1}, newer than this store's ${MIGRATIONS.length}`,
		);
	});
});
