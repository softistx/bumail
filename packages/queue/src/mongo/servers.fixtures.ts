import { afterAll, afterEach, describe, test } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import type { QueueStore } from '../contract/queue-store';
import { MongoQueueStore } from './store';

/**
 * The MongoDB the MongoDB specs run against, from the environment: `bun
 * run mongo:test` starts one in Docker and prints the line to set. Its
 * database is the URL's.
 */
export const MONGO_URL = process.env['BUMAIL_TEST_MONGO_URL'];

const SKIPPED = `BUMAIL_TEST_MONGO_URL is not set: start MongoDB with \`bun run mongo:test\` and export the URL it prints`;

let warned = false;

/**
 * `describe` with the URL when there is one; otherwise one skipped test
 * that says how to run them, and a warning, once per process — or, with
 * `BUMAIL_TEST_MONGO_REQUIRED` set, an error.
 */
export function describeMongo(name: string, body: (url: string) => void): void {
	if (MONGO_URL) {
		describe(name, () => body(MONGO_URL));
		return;
	}
	// CI's job sets it, so a lost URL fails there rather than skip unseen.
	if (process.env['BUMAIL_TEST_MONGO_REQUIRED']) {
		throw new Error(
			`BUMAIL_TEST_MONGO_REQUIRED is set but BUMAIL_TEST_MONGO_URL is not: the MongoDB specs cannot run`,
		);
	}
	if (!warned) console.warn(`MongoDB specs skipped: ${SKIPPED}`);
	warned = true;
	describe(name, () => test.skip(SKIPPED, () => {}));
}

/** The names of a queue's collections under `prefix`. */
export const collectionsOf = (prefix: string) =>
	['items', 'messages', 'schema'].map((c) => `${prefix}${c}`);

/**
 * Stores for one test each, every one on collections of its own (a
 * random prefix), through a client of its own: each client is closed,
 * and its collections dropped, once its test has run. Call inside
 * `describeMongo`.
 */
export function temporaryStores(url: string) {
	const adminClient = new MongoClient(url);
	const admin: Db = adminClient.db();
	let clients: MongoClient[] = [];
	let prefixes: string[] = [];
	const prefixOf = new WeakMap<QueueStore, string>();
	afterEach(async () => {
		const [done, dropped] = [clients, prefixes];
		[clients, prefixes] = [[], []];
		await Promise.all(done.map((client) => client.close()));
		for (const prefix of dropped) {
			for (const name of collectionsOf(prefix)) {
				await admin
					.collection(name)
					.drop()
					.catch(() => {});
			}
		}
	});
	afterAll(() => adminClient.close());
	/** A database through a client of its own, as another instance of a server would hold. */
	const db = (): Db => {
		const made = new MongoClient(url);
		clients.push(made);
		return made.db();
	};
	const open = (collectionPrefix: string) => {
		const store = MongoQueueStore.open({ db: db(), collectionPrefix });
		prefixOf.set(store, collectionPrefix);
		return store;
	};
	/** A prefix no other test uses, its collections dropped after the test. */
	const prefix = () => {
		const made = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}_`;
		prefixes.push(made);
		return made;
	};
	/** A new store, on new collections. */
	const create = () => open(prefix());
	/** Another store on the collections of `store`, through another client: another instance. */
	const share = (store: QueueStore) => open(prefixOf.get(store) as string);
	const prefixFor = (store: QueueStore) => prefixOf.get(store) as string;
	return { admin, db, create, prefix, share, prefixFor };
}
