import { afterAll, afterEach, describe, test } from 'bun:test';
import type { QueueStore } from '../contract/queue-store';
import type { RedisQueueClient } from './options';
import { RedisQueueStore } from './store';

/**
 * The Redis the Redis specs run against, from the environment: `bun run
 * redis:test` starts one in Docker and prints the line to set.
 */
export const REDIS_URL = process.env['BUMAIL_TEST_REDIS_URL'];

const SKIPPED = `BUMAIL_TEST_REDIS_URL is not set: start Redis with \`bun run redis:test\` and export the URL it prints`;

let warned = false;

/**
 * `describe` with the URL when there is one; otherwise one skipped test
 * that says how to run them, and a warning, once per process — or, with
 * `BUMAIL_TEST_REDIS_REQUIRED` set, an error.
 */
export function describeRedis(name: string, body: (url: string) => void): void {
	if (REDIS_URL) {
		describe(name, () => body(REDIS_URL));
		return;
	}
	// CI's job sets it, so a lost URL fails there rather than skip unseen.
	if (process.env['BUMAIL_TEST_REDIS_REQUIRED']) {
		throw new Error(
			`BUMAIL_TEST_REDIS_REQUIRED is set but BUMAIL_TEST_REDIS_URL is not: the Redis specs cannot run`,
		);
	}
	if (!warned) console.warn(`Redis specs skipped: ${SKIPPED}`);
	warned = true;
	describe(name, () => test.skip(SKIPPED, () => {}));
}

/** Every key under `prefix`, by `SCAN`: the prefix holds no glob character. */
export async function keysUnder(
	client: RedisQueueClient,
	prefix: string,
): Promise<string[]> {
	const found: string[] = [];
	let cursor = '0';
	do {
		const [next, keys] = (await client.send('SCAN', [
			cursor,
			'MATCH',
			`${prefix}*`,
			'COUNT',
			'1000',
		])) as [string, string[]];
		found.push(...keys);
		cursor = next;
	} while (cursor !== '0');
	return found;
}

/**
 * Stores for one test each, every one under keys of its own (a random
 * prefix), through a client of its own: each client is closed, and its
 * keys deleted, once its test has run. Call inside `describeRedis`.
 */
export function temporaryStores(url: string) {
	const admin = new Bun.RedisClient(url) as unknown as RedisQueueClient;
	let clients: RedisQueueClient[] = [];
	let prefixes: string[] = [];
	const prefixOf = new WeakMap<QueueStore, string>();
	afterEach(async () => {
		const [done, dropped] = [clients, prefixes];
		[clients, prefixes] = [[], []];
		for (const client of done) client.close();
		for (const prefix of dropped) {
			const keys = await keysUnder(admin, prefix);
			if (keys.length > 0) await admin.send('DEL', keys);
		}
	});
	afterAll(() => admin.close());
	/** A client of its own, as another instance of a server would hold. */
	const client = (): RedisQueueClient => {
		const made = new Bun.RedisClient(url) as unknown as RedisQueueClient;
		clients.push(made);
		return made;
	};
	const open = (keyPrefix: string) => {
		const store = RedisQueueStore.open({ client: client(), keyPrefix });
		prefixOf.set(store, keyPrefix);
		return store;
	};
	/** A prefix no other test uses, its keys deleted after the test. */
	const prefix = () => {
		const made = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}:`;
		prefixes.push(made);
		return made;
	};
	/** A new store, under new keys. */
	const create = () => open(prefix());
	/** Another store on the keys of `store`, through another client: another instance. */
	const share = (store: QueueStore) => open(prefixOf.get(store) as string);
	const prefixFor = (store: QueueStore) => prefixOf.get(store) as string;
	return { admin, client, create, prefix, share, prefixFor };
}
