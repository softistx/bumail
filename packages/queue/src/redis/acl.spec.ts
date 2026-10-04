import { expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import { describeRedis, temporaryStores } from './servers.fixtures';
import { RedisQueueStore } from './store';

/** What the store sends, and what its scripts call: the guide's `ACL SETUSER` line. */
const COMMANDS = [
	'evalsha',
	'eval',
	'get',
	'set',
	'del',
	'incr',
	'hgetall',
	'hget',
	'hset',
	'hdel',
	'hincrby',
	'zadd',
	'zrem',
	'zrange',
	'zrangebyscore',
	'zcard',
];

describeRedis('RedisQueueStore with an ACL user', (url) => {
	const { admin, prefix } = temporaryStores(url);

	/** A user with `commands` on the keys under `keyPrefix` only; deleted once `body` has run. */
	async function asWorker(
		keyPrefix: string,
		commands: string[],
		body: (workerUrl: URL) => Promise<void>,
	) {
		const user = `bumail-worker-${crypto.randomUUID().slice(0, 8)}`;
		await admin.send('ACL', [
			'SETUSER',
			user,
			'on',
			'>worker',
			'resetkeys',
			`~${keyPrefix}*`,
			'-@all',
			...commands.map((c) => `+${c}`),
		]);
		try {
			const workerUrl = new URL(url);
			workerUrl.username = user;
			workerUrl.password = 'worker';
			await body(workerUrl);
		} finally {
			await admin.send('ACL', ['DELUSER', user]);
		}
	}

	test('those commands, on the keys under the prefix, run the queue', async () => {
		const keyPrefix = prefix();
		await asWorker(keyPrefix, COMMANDS, async (workerUrl) => {
			const store = RedisQueueStore.open({ url: workerUrl, keyPrefix });
			try {
				const item = await store.add(entry(), { maxItems: 10 });
				expect(await store.readMessage(item.id)).toBeDefined();
				const claimed = await store.claim({
					owner: 'w1',
					now: T0,
					leaseMs: MINUTE,
				});
				expect(claimed?.id).toBe(item.id);
				expect(await store.renew(item.id, 'w1', T0 + 2 * MINUTE)).toBe(true);
				const later = await store.complete(item.id, 'w1', {
					now: T0,
					recipients: [{ address: 'joe@example.com', status: 'delivered' }],
					nextAttemptAt: T0 + MINUTE,
					attempts: 1,
					delayNotified: false,
				});
				expect(later?.attempts).toBe(1);
				expect(await store.reschedule(item.id, T0)).toBe(true);
				expect((await store.list()).map((i) => i.id)).toEqual([item.id]);
				expect((await store.cancel(item.id))?.id).toBe(item.id);
				expect(await store.count()).toBe(0);
			} finally {
				await store.close();
			}
		});
	});

	test('a user kept off the prefix is told at the first call', async () => {
		const keyPrefix = prefix();
		await asWorker(`${keyPrefix}other:`, COMMANDS, async (workerUrl) => {
			const store = RedisQueueStore.open({ url: workerUrl, keyPrefix });
			try {
				await expect(store.count()).rejects.toThrow(
					'The Redis queue cannot be set up: ',
				);
				await expect(store.count()).rejects.toMatchObject({ code: 'INVALID' });
			} finally {
				await store.close();
			}
		});
	});
});
