import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytes } from '../contract/fixtures/setup.fixtures';
import { BlobFiles } from './blobs';
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

describe('SqliteMailStore.open: privacy', () => {
	const modeOf = (path: string) => statSync(path).mode & 0o777;

	test("the directories are 0700 and the files 0600: mail is its owner's", async () => {
		const at = join(directory(), 'nested', 'mail');
		const store = open(at);
		await store.createAccount('mary@example.net');
		const { blobId } = await new BlobFiles(join(at, 'blobs')).write(
			bytes('private'),
		);
		const shard = join(at, 'blobs', blobId.slice(0, 2));
		for (const path of [join(at, '..'), at, join(at, 'blobs'), shard]) {
			expect([path, modeOf(path)]).toEqual([path, 0o700]);
		}
		const sqlite = join(at, 'mail.sqlite');
		expect(existsSync(`${sqlite}-wal`)).toBe(true);
		for (const path of [sqlite, `${sqlite}-wal`, join(shard, blobId)]) {
			expect([path, modeOf(path)]).toEqual([path, 0o600]);
		}
		expect(readdirSync(join(at, 'blobs'))).toEqual([blobId.slice(0, 2)]);
	});

	test('a database made world-readable is made private again on open', () => {
		const at = directory();
		writeFileSync(join(at, 'mail.sqlite'), '', { mode: 0o644 });
		open(at);
		expect(modeOf(join(at, 'mail.sqlite'))).toBe(0o600);
	});
});

describe('SqliteMailStore.close', () => {
	test("a call after it is INVALID, never SQLite's own error", async () => {
		const store = open();
		const account = await store.createAccount('mary@example.net');
		store.close();
		for (const call of [
			store.createAccount('john@example.net'),
			store.getAccount(account.id),
			store.listMailboxes(account.id),
			store.deleteMailbox(account.id, 'x'),
			store.mailboxChanges(account.id, 0),
		]) {
			await expect(call).rejects.toMatchObject({
				name: 'StoreError',
				code: 'INVALID',
				message: 'The store is closed',
			});
		}
	});
});

describe('SqliteMailStore.open: the schema', () => {
	test('an expunged tombstone, and only one, names when its message joined', () => {
		const at = directory();
		open(at).close();
		const db = new Database(join(at, 'mail.sqlite'));
		try {
			db.exec(
				"INSERT INTO accounts (id, name, login_key) VALUES ('a', 'a', 'a')",
			);
			const bury = (kind: string, joined: number | null) =>
				db
					.query(
						'INSERT INTO tombstones (account_id, kind, modseq, id, created_modseq, joined_modseq) VALUES (?, ?, 1, ?, 1, ?)',
					)
					.run('a', kind, crypto.randomUUID(), joined);
			bury('expunged', 1);
			bury('mailbox', null);
			expect(() => bury('expunged', null)).toThrow('CHECK');
			expect(() => bury('message', 1)).toThrow('CHECK');
		} finally {
			db.close();
		}
	});

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
});
