import { afterAll, afterEach, describe, test } from 'bun:test';
import type { QueueStore } from '../contract/queue-store';
import type { PostgresClient } from './options';
import { PostgresQueueStore } from './store';

/**
 * The database the PostgreSQL specs run against, from the environment:
 * `bun run postgres:test` starts one in Docker and prints the line to set.
 */
export const POSTGRES_URL = process.env['BUMAIL_TEST_POSTGRES_URL'];

const SKIPPED = `BUMAIL_TEST_POSTGRES_URL is not set: start PostgreSQL with \`bun run postgres:test\` and export the URL it prints`;

let warned = false;

/**
 * `describe` with the URL when there is one; otherwise one skipped test
 * that says how to run them, and a warning, once per process.
 */
export function describePostgres(
	name: string,
	body: (url: string) => void,
): void {
	if (POSTGRES_URL) {
		describe(name, () => body(POSTGRES_URL));
		return;
	}
	if (!warned) console.warn(`PostgreSQL specs skipped: ${SKIPPED}`);
	warned = true;
	describe(name, () => test.skip(SKIPPED, () => {}));
}

/**
 * Stores for one test each, every one on tables of its own (a random
 * prefix), through a client of its own: each store and client is closed,
 * and its tables dropped, once its test has run. Call inside
 * `describePostgres`.
 */
export function temporaryStores(url: string) {
	const admin = new Bun.SQL(url, { max: 1 });
	let clients: PostgresClient[] = [];
	let prefixes: string[] = [];
	const prefixOf = new WeakMap<QueueStore, string>();
	afterEach(async () => {
		const [done, dropped] = [clients, prefixes];
		[clients, prefixes] = [[], []];
		await Promise.all(done.map((client) => client.close({ timeout: 1 })));
		for (const p of dropped) {
			await admin.unsafe(
				`DROP TABLE IF EXISTS ${p}messages, ${p}items, ${p}schema`,
			);
		}
	});
	afterAll(() => admin.close());
	/** A client of its own, as another instance of a server would hold. */
	const client = (max = 4): PostgresClient => {
		const made = new Bun.SQL(url, { max }) as unknown as PostgresClient;
		clients.push(made);
		return made;
	};
	const open = (tablePrefix: string) => {
		const store = PostgresQueueStore.open({ sql: client(), tablePrefix });
		prefixOf.set(store, tablePrefix);
		return store;
	};
	/** A prefix no other test uses, its tables dropped after the test. */
	const prefix = () => {
		const made = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}_`;
		prefixes.push(made);
		return made;
	};
	/** A new store, on new tables. */
	const create = () => open(prefix());
	/** Another store on the tables of `store`, through another client: another instance. */
	const share = (store: QueueStore) => open(prefixOf.get(store) as string);
	const tablesOf = (store: QueueStore) => prefixOf.get(store) as string;
	return { admin, client, create, prefix, share, tablesOf };
}
