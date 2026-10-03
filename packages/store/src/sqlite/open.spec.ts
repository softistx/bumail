import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rejects } from '../contract/fixtures/setup.fixtures';
import { temporaryStores } from './directories.fixtures';
import { MIGRATIONS } from './schema';
import { SqliteMailStore } from './store';

const { directory, open } = temporaryStores();

const refused = (run: () => unknown, message: string | RegExp) => {
	expect(run).toThrow(message);
	try {
		run();
	} catch (error) {
		expect(error).toMatchObject({ name: 'StoreError', code: 'INVALID' });
	}
};

describe('SqliteMailStore.open', () => {
	test('makes the directory, its database and its blobs', () => {
		const at = join(directory(), 'nested', 'mail');
		open(at);
		expect(existsSync(join(at, 'mail.sqlite'))).toBe(true);
		expect(existsSync(join(at, 'blobs'))).toBe(true);
	});

	test('a second opener of the same directory is refused, until the first closes', () => {
		const at = directory();
		const first = open(at);
		refused(() => SqliteMailStore.open({ directory: at }), 'already open');
		first.close();
		first.close();
		open(at);
	});

	test('reopening keeps the data, and the modseqs and UIDVALIDITYs go on', async () => {
		const at = directory();
		const first = open(at);
		const account = await first.createAccount('mary@example.net');
		const inbox = await first.createMailbox(account.id, {
			name: 'INBOX',
			role: 'inbox',
		});
		const { modseq } = await first.mailboxChanges(account.id, 0);
		first.close();

		const again = open(at);
		expect(await again.findAccount('MARY@example.net')).toEqual(account);
		expect(await again.findMailbox(account.id, 'inbox')).toEqual(inbox);
		const sent = await again.createMailbox(account.id, { name: 'Sent' });
		expect(sent.highestModseq).toBe(modseq + 1);
		expect(sent.uidValidity).toBeGreaterThan(inbox.uidValidity);
		expect(await again.mailboxChanges(account.id, modseq)).toMatchObject({
			created: [sent.id],
		});
	});
});

describe('SqliteMailStore.open: the schema', () => {
	test('writes the schema version and the WAL journal', () => {
		const at = directory();
		open(at).close();
		const db = new Database(join(at, 'mail.sqlite'), { readonly: true });
		try {
			expect(db.query('PRAGMA user_version').get()).toEqual({
				user_version: MIGRATIONS.length,
			});
			expect(db.query('PRAGMA journal_mode').get()).toEqual({
				journal_mode: 'wal',
			});
		} finally {
			db.close();
		}
	});

	test('a database from a newer store is refused, and left as it is', () => {
		const at = directory();
		open(at).close();
		const db = new Database(join(at, 'mail.sqlite'));
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
		db.close();
		refused(() => SqliteMailStore.open({ directory: at }), 'newer');
		const check = new Database(join(at, 'mail.sqlite'), { readonly: true });
		expect(check.query('PRAGMA user_version').get()).toEqual({
			user_version: MIGRATIONS.length + 1,
		});
		check.close();
	});

	test('no directory, or a file that is no database, is INVALID', () => {
		refused(
			() => SqliteMailStore.open(undefined as never),
			'needs a directory',
		);
		refused(() => SqliteMailStore.open({ directory: '' }), 'needs a directory');
		const at = directory();
		writeFileSync(
			join(at, 'mail.sqlite'),
			'not a database, just text '.repeat(40),
		);
		refused(() => SqliteMailStore.open({ directory: at }), 'cannot be opened');
	});

	test('what the next slices answer is refused, never faked', async () => {
		const store = open();
		const account = await store.createAccount('mary@example.net');
		await expect(store.getMessage(account.id, 'x')).rejects.toThrow(
			'not implemented in this slice',
		);
		await expect(store.messageChanges(account.id, 0)).rejects.toThrow(
			'not implemented in this slice',
		);
		await rejects(store.mailboxChanges('nope', 0), 'NOT_FOUND');
	});
});
