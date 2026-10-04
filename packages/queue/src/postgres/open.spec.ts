import { describe, expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';
import type { PostgresClient } from './options';
import { migrations } from './schema';
import { PostgresQueueStore } from './store';

// A `Bun.SQL` client is what the store takes, though its type names none:
// a change on either side that breaks the fit fails typecheck here.
const fits = (sql: Bun.SQL): PostgresClient => sql;

/** Nothing listens on port 1: every connection is refused at once. */
const NOWHERE = 'postgres://bumail:secret@127.0.0.1:1/queue';

describe('PostgresQueueStore.open', () => {
	test('refuses what is not a client nor a postgres:// URL, never echoing the URL', () => {
		const needs =
			'A PostgreSQL queue store needs sql: a Bun.SQL client or a postgres:// URL';
		expect(() => PostgresQueueStore.open({} as { sql: string })).toThrow(needs);
		expect(() => PostgresQueueStore.open({ sql: 'not a url' })).toThrow(needs);
		expect(() =>
			PostgresQueueStore.open({ sql: 'mysql://root:secret@localhost/q' }),
		).toThrow(needs);
		expect(() =>
			PostgresQueueStore.open({ sql: { unsafe() {} } as never }),
		).toThrow(needs);
	});

	test('a URL Bun.SQL refuses is INVALID, the password never repeated', () => {
		const open = () =>
			PostgresQueueStore.open({
				sql: 'postgres://bumail:secret@127.0.0.1:1/queue?sslmode=bogus',
			});
		expect(open).toThrow(
			"The URL in sql cannot be opened: The argument 'sslmode' must be one of",
		);
		expect(open).toThrow(expect.objectContaining({ code: 'INVALID' }));
		expect(open).not.toThrow('secret');
		expect(open).not.toThrow('127.0.0.1');
	});

	test('a password that is not valid percent-encoding is masked as written, still INVALID', () => {
		const open = () =>
			PostgresQueueStore.open({
				sql: 'postgres://bumail:p%zz@127.0.0.1:1/queue?sslmode=bogus',
			});
		expect(open).toThrow(
			expect.objectContaining({
				code: 'INVALID',
				message: expect.stringContaining('The URL in sql cannot be opened:'),
			}),
		);
		expect(open).not.toThrow('p%zz');
	});

	test('refuses a Bun.SQL client for another database', () => {
		const sqlite = new Bun.SQL(':memory:', { adapter: 'sqlite' });
		expect(() => PostgresQueueStore.open({ sql: fits(sqlite) })).toThrow(
			'sql is a sqlite client; the queue needs a PostgreSQL one',
		);
		sqlite.close();
	});

	test('refuses a table prefix that is not a plain name', () => {
		for (const tablePrefix of [
			'Queue_',
			'1q_',
			'q-',
			'q;drop',
			'',
			'x'.repeat(41),
		]) {
			expect(() =>
				PostgresQueueStore.open({ sql: NOWHERE, tablePrefix }),
			).toThrow(
				`tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not ${JSON.stringify(tablePrefix)}`,
			);
		}
	});

	test('connects to nothing until used; a database out of reach is INVALID, and tried again', async () => {
		const store = PostgresQueueStore.open({ sql: NOWHERE });
		const first = store.count();
		await expect(first).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringContaining(
				'The PostgreSQL queue cannot be set up:',
			),
		});
		await expect(first).rejects.not.toThrow('secret');
		await expect(store.migrate()).rejects.toMatchObject({ code: 'INVALID' });
		await store.close();
		await store.close();
		await expect(store.count()).rejects.toMatchObject({ code: 'CLOSED' });
		await expect(store.migrate()).rejects.toMatchObject({ code: 'CLOSED' });
	});
});

describePostgres('PostgresQueueStore on PostgreSQL', (url) => {
	const { admin, client, create, prefix, share, tablesOf } =
		temporaryStores(url);

	test('migrate makes the tables once, however many instances start together', async () => {
		const store = create();
		const others = Array.from({ length: 4 }, () => share(store));
		await Promise.all([store, ...others].map((s) => s.migrate()));
		await store.migrate();
		expect(await store.count()).toBe(0);
	});

	test('an item, its message and its lease outlive the instance', async () => {
		const first = create();
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
		const item = await first.add(entry({ message: bytes }));
		await first.claim({ owner: 'w1', now: T0, leaseMs: MINUTE });
		await first.close();
		const again = share(first);
		expect((await again.get(item.id))?.lease?.owner).toBe('w1');
		expect(await again.readMessage(item.id)).toEqual(bytes);
	});

	test('the claim reads the due index', async () => {
		const store = create();
		await store.migrate();
		const due = `${tablesOf(store)}items_due`;
		const [index] = (await admin.unsafe(
			'SELECT indexdef FROM pg_indexes WHERE indexname = $1',
			[due],
		)) as { indexdef: string }[];
		expect(index?.indexdef).toContain('(next_attempt_at, seq)');
		// Planned with sequential scans off, as on a table large enough for
		// the planner to prefer the index on its own.
		const plan = await admin.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off');
			return tx.unsafe(
				`EXPLAIN (FORMAT JSON) SELECT seq FROM ${tablesOf(store)}items
				WHERE next_attempt_at <= 0 ORDER BY next_attempt_at, seq LIMIT 1`,
			);
		});
		expect(JSON.stringify(plan)).toContain(due);
	});

	test('tables from a newer store are refused', async () => {
		const store = create();
		await store.migrate();
		const newer =
			migrations({ prefix: '', items: '', messages: '', schema: '' }).length +
			1;
		await admin.unsafe(
			`UPDATE ${tablesOf(store)}schema SET version = ${newer}`,
		);
		const later = share(store);
		await expect(later.count()).rejects.toThrow(
			`The database is at schema version ${newer}, newer than this store's ${newer - 1}`,
		);
	});

	test('close leaves a client it was given open, and closes one it opened', async () => {
		const given = client();
		const store = PostgresQueueStore.open({
			sql: given,
			tablePrefix: prefix(),
		});
		await store.migrate();
		await store.close();
		expect(await given.unsafe('SELECT 1 AS one')).toEqual([{ one: 1 }]);
		const owned = PostgresQueueStore.open({
			sql: new URL(url),
			tablePrefix: prefix(),
		});
		await owned.migrate();
		await owned.close();
		await expect(owned.count()).rejects.toMatchObject({ code: 'CLOSED' });
	});

	test('a set-up error that repeats the password masks it, for a URL and for a given client', async () => {
		// A role that does not exist, named as its password: PostgreSQL's
		// reason names the role.
		const wrong = new URL(url);
		wrong.username = 'bumailnobody';
		wrong.password = 'bumailnobody';
		const refused = 'password authentication failed for user "…"';
		const owned = PostgresQueueStore.open({ sql: wrong });
		await expect(owned.count()).rejects.toMatchObject({
			code: 'INVALID',
			message: `The PostgreSQL queue cannot be set up: ${refused}`,
		});
		await owned.close();
		const given = new Bun.SQL(wrong.href, { max: 1 });
		const store = PostgresQueueStore.open({ sql: fits(given) });
		await expect(store.count()).rejects.toMatchObject({
			code: 'INVALID',
			message: `The PostgreSQL queue cannot be set up: ${refused}`,
		});
		await given.close();
	});
});
