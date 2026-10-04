import { describe, expect, test } from 'bun:test';
import { bytes } from '../contract/fixtures/setup.fixtures';
import { tablesOf } from './connect';
import {
	describePostgres,
	tableList,
	temporaryStores,
} from './databases.fixtures';
import type { PostgresClient } from './options';
import { migrations } from './schema';
import { PostgresMailStore } from './store';

// A `Bun.SQL` client is what the store takes, though its type names none:
// a change on either side that breaks the fit fails typecheck here.
const fits = (sql: Bun.SQL): PostgresClient => sql;

/** Nothing listens on port 1: every connection is refused at once. */
const NOWHERE = 'postgres://bumail:secret@127.0.0.1:1/mail';

describe('PostgresMailStore.open', () => {
	test('refuses what is not a client nor a postgres:// URL, never echoing the URL', () => {
		const needs =
			'A PostgreSQL mail store needs sql: a Bun.SQL client or a postgres:// URL';
		expect(() => PostgresMailStore.open({} as { sql: string })).toThrow(needs);
		expect(() => PostgresMailStore.open(undefined as never)).toThrow(needs);
		expect(() => PostgresMailStore.open({ sql: 'not a url' })).toThrow(needs);
		expect(() =>
			PostgresMailStore.open({ sql: 'mysql://root:secret@localhost/m' }),
		).toThrow(needs);
		expect(() =>
			PostgresMailStore.open({ sql: { unsafe() {} } as never }),
		).toThrow(needs);
	});

	test('a URL Bun.SQL refuses is INVALID, the password never repeated', () => {
		const open = () =>
			PostgresMailStore.open({
				sql: 'postgres://bumail:secret@127.0.0.1:1/mail?sslmode=bogus',
			});
		expect(open).toThrow(
			"The URL in sql cannot be opened: The argument 'sslmode' must be one of",
		);
		expect(open).toThrow(expect.objectContaining({ code: 'INVALID' }));
		expect(open).not.toThrow('secret');
		expect(open).not.toThrow('127.0.0.1');
	});

	test('refuses a Bun.SQL client for another database', () => {
		const sqlite = new Bun.SQL(':memory:', { adapter: 'sqlite' });
		expect(() => PostgresMailStore.open({ sql: fits(sqlite) })).toThrow(
			'sql is a sqlite client; the mail store needs a PostgreSQL one',
		);
		sqlite.close();
	});

	test('refuses a table prefix that is not a plain name', () => {
		for (const tablePrefix of [
			'Mail_',
			'1m_',
			'm-',
			'm;drop',
			'',
			'x'.repeat(41),
		]) {
			expect(() =>
				PostgresMailStore.open({ sql: NOWHERE, tablePrefix }),
			).toThrow(
				`tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not ${JSON.stringify(tablePrefix)}`,
			);
		}
	});

	test('refuses a bad maxTombstones', () => {
		for (const maxTombstones of [-1, 1.5, Number.NaN]) {
			expect(() =>
				PostgresMailStore.open({ sql: NOWHERE, maxTombstones }),
			).toThrow(
				`maxTombstones must be an integer of at least 0, not ${maxTombstones}`,
			);
		}
	});

	test('connects to nothing until used; a database out of reach is INVALID, and tried again', async () => {
		const store = PostgresMailStore.open({ sql: NOWHERE });
		const first = store.listMailboxes('anyone');
		await expect(first).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringContaining(
				'The PostgreSQL mail store cannot be set up:',
			),
		});
		await expect(first).rejects.not.toThrow('secret');
		await expect(store.migrate()).rejects.toMatchObject({ code: 'INVALID' });
		await store.close();
		await store.close();
		await expect(store.getAccount('a')).rejects.toThrow('The store is closed');
		await expect(store.migrate()).rejects.toMatchObject({ code: 'INVALID' });
	});
});

describePostgres('PostgresMailStore on PostgreSQL', (url) => {
	const { admin, client, create, prefix, share, tablesFor } =
		temporaryStores(url);

	test('migrate makes the tables once, however many instances start together', async () => {
		const store = create();
		const others = Array.from({ length: 4 }, () => share(store));
		await Promise.all([store, ...others].map((s) => s.migrate()));
		await store.migrate();
		expect(await store.findAccount('nobody')).toBeUndefined();
	});

	test('a prefix of 40 keeps every name whole, each its own', async () => {
		const long = `${'p'.repeat(39)}_`;
		const store = PostgresMailStore.open({ sql: client(), tablePrefix: long });
		try {
			await store.migrate();
			const names = (await admin.unsafe(
				`SELECT conname AS name FROM pg_constraint c
					JOIN pg_class t ON t.oid = c.conrelid
					WHERE t.relname LIKE $1 AND c.contype <> 'n'
				UNION ALL
				SELECT indexname FROM pg_indexes WHERE tablename LIKE $1`,
				[`${long}%`],
			)) as { name: string }[];
			expect(names.length).toBeGreaterThan(20);
			for (const { name } of names) {
				expect(name.startsWith(long)).toBe(true);
				expect(name.length).toBeLessThanOrEqual(63);
			}
		} finally {
			await admin.unsafe(`DROP TABLE IF EXISTS ${tableList(long).join(', ')}`);
		}
	});

	test('mail, flags, UIDs and changes outlive the instance', async () => {
		const first = create();
		const account = await first.createAccount('mary@example.net');
		const inbox = await first.createMailbox(account.id, { name: 'INBOX' });
		const content = Uint8Array.from({ length: 256 }, (_, i) => i);
		const a = await first.addMessage(account.id, inbox.id, {
			content,
			flags: ['$Label'],
			receivedAt: new Date('2026-01-02T03:04:05Z'),
		});
		const before = await first.listAccountMessages(account.id);
		const boxes = await first.listMailboxes(account.id);
		await first.close();
		const again = share(first);
		expect(await again.listAccountMessages(account.id)).toEqual(before);
		expect(await again.listMailboxes(account.id)).toEqual(boxes);
		const blob = await again.readContent(account.id, a.blobId);
		expect(new Uint8Array((await blob?.arrayBuffer()) ?? [])).toEqual(content);
		const b = await again.addMessage(account.id, inbox.id, {
			content: bytes('b'),
		});
		expect(b.mailboxes[0]?.uid).toBe(2);
		expect(b.modseq).toBe(a.modseq + 1);
	});

	test('content is kept once per account, and goes with its last message', async () => {
		const store = create();
		const mary = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(mary.id, { name: 'INBOX' });
		const one = await store.addMessage(mary.id, inbox.id, {
			content: bytes('same'),
		});
		const two = await store.addMessage(mary.id, inbox.id, {
			content: bytes('same'),
		});
		const contents = `${tablesFor(store)}contents`;
		const count = async () =>
			Number(
				(
					(await admin.unsafe(`SELECT count(*) AS n FROM ${contents}`)) as {
						n: string;
					}[]
				)[0]?.n,
			);
		expect(await count()).toBe(1);
		await store.destroyMessages(mary.id, [one.id]);
		expect(await count()).toBe(1);
		await store.destroyMessages(mary.id, [two.id]);
		expect(await count()).toBe(0);
	});

	test('the changes are cut in the database: one page leaves it, not every change', async () => {
		const store = create();
		const account = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
		for (let i = 0; i < 30; i++) {
			await store.addMessage(account.id, inbox.id, { content: bytes(`${i}`) });
		}
		// Every statement the store sends is counted by the rows it returns.
		const counting = client();
		let largest = 0;
		const spy: PostgresClient = {
			unsafe: async (q, v) => {
				const rows = (await counting.unsafe(q, v)) as unknown[];
				largest = Math.max(largest, rows.length);
				return rows;
			},
			begin: (fn) =>
				counting.begin((tx) =>
					fn({
						unsafe: async (q, v) => {
							const rows = (await tx.unsafe(q, v)) as unknown[];
							largest = Math.max(largest, rows.length);
							return rows;
						},
					}),
				),
			close: () => counting.close(),
		};
		const reader = PostgresMailStore.open({
			sql: spy,
			tablePrefix: tablesFor(store),
		});
		const page = await reader.messageChanges(account.id, 0, { limit: 5 });
		expect(page.created).toHaveLength(5);
		expect(page.hasMore).toBe(true);
		expect(largest).toBeLessThanOrEqual(6);
		largest = 0;
		const listed = await reader.listAccountMessages(account.id, {
			offset: 10,
			limit: 3,
		});
		expect(listed.messages).toHaveLength(3);
		expect(listed.total).toBe(30);
		expect(largest).toBe(3);
	});

	test('tables from a newer store are refused', async () => {
		const store = create();
		await store.migrate();
		const newer = migrations(tablesOf('')).length + 1;
		await admin.unsafe(
			`UPDATE ${tablesFor(store)}schema SET version = ${newer}`,
		);
		const later = share(store);
		await expect(later.findAccount('x')).rejects.toThrow(
			`The database is at schema version ${newer}, newer than this store's ${newer - 1}`,
		);
	});

	test('close leaves a client it was given open, and closes one it opened', async () => {
		const given = client();
		const store = PostgresMailStore.open({
			sql: given,
			tablePrefix: prefix(),
		});
		await store.migrate();
		await store.close();
		expect(await given.unsafe('SELECT 1 AS one')).toEqual([{ one: 1 }]);
		const owned = PostgresMailStore.open({
			sql: new URL(url),
			tablePrefix: prefix(),
		});
		await owned.migrate();
		await owned.close();
		await expect(owned.findAccount('x')).rejects.toThrow('The store is closed');
	});
});
