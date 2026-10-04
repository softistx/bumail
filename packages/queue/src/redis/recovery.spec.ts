import { expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import type { RedisQueueClient } from './options';
import { describeRedis, temporaryStores } from './servers.fixtures';
import { RedisQueueStore } from './store';

const lease = { leaseMs: MINUTE };

describeRedis('RedisQueueStore when something went wrong', (url) => {
	const { admin, client, create, prefix, prefixFor, share } =
		temporaryStores(url);

	test('an item whose hash is gone (evicted, deleted by hand) is dropped by the next claim, never leased', async () => {
		const store = create();
		const lost = await store.add(entry());
		const kept = await store.add(entry());
		await admin.send('DEL', [`${prefixFor(store)}item:${lost.id}`]);
		expect(await store.list()).toEqual([kept]);
		const claimed = await store.claim({ owner: 'w', now: T0, ...lease });
		expect(claimed?.id).toBe(kept.id);
		expect(await store.count()).toBe(1);
		expect(await store.get(lost.id)).toBeUndefined();
		expect(await store.readMessage(lost.id)).toBeUndefined();
		// The same for one whose lease expired.
		await admin.send('DEL', [`${prefixFor(store)}item:${kept.id}`]);
		const later = T0 + 2 * MINUTE;
		expect(
			await store.claim({ owner: 'v', now: later, ...lease }),
		).toBeUndefined();
		expect(await store.count()).toBe(0);
		expect(
			await admin.send('EXISTS', [`${prefixFor(store)}item:${kept.id}`]),
		).toBe(0);
	});

	test('a schema key that holds no layout version is refused', async () => {
		const keyPrefix = prefix();
		await admin.send('SET', [`${keyPrefix}schema`, 'hello']);
		const store = RedisQueueStore.open({ client: client(), keyPrefix });
		await expect(store.count()).rejects.toMatchObject({
			code: 'INVALID',
			message: `The key ${keyPrefix}schema does not hold a layout version: is the prefix another application's?`,
		});
	});

	test('complete reads the item again when another outcome was recorded since it read it', async () => {
		const other = create();
		const item = await other.add(entry());
		await other.claim({ owner: 'w', now: T0, ...lease });
		const real = client();
		let armed = true;
		// Between complete's read and its script, the same owner records an
		// outcome and claims the item again, on another handle.
		const racing: RedisQueueClient = {
			send: async (command, args) => {
				const reply = await real.send(command, args);
				if (armed && command === 'HGETALL') {
					armed = false;
					await other.complete(item.id, 'w', {
						now: T0,
						recipients: [{ address: 'joe@example.com', status: 'delivered' }],
						nextAttemptAt: T0 + MINUTE,
						attempts: 1,
						delayNotified: false,
					});
					await other.claim({ owner: 'w', now: T0 + MINUTE, ...lease });
				}
				return reply;
			},
			getBuffer: (key) => real.getBuffer(key),
			close: () => real.close(),
		};
		const store = RedisQueueStore.open({
			client: racing,
			keyPrefix: prefixFor(other),
		});
		const done = await store.complete(item.id, 'w', {
			now: T0 + MINUTE,
			recipients: [{ address: 'ann@example.org', status: 'deferred' }],
			nextAttemptAt: T0 + 30 * MINUTE,
			attempts: 2,
			delayNotified: false,
		});
		expect(armed).toBe(false);
		expect(done?.recipients.map((r) => r.status)).toEqual([
			'delivered',
			'deferred',
		]);
		expect(await share(other).get(item.id)).toEqual(done);
	});
});
