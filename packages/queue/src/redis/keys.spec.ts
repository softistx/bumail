import { expect, test } from 'bun:test';
import {
	entry,
	MINUTE,
	rejects,
	T0,
} from '../contract/fixtures/setup.fixtures';
import type { QueueStore } from '../contract/queue-store';
import { describeRedis, keysUnder, temporaryStores } from './servers.fixtures';
import { RedisQueueStore } from './store';

const lease = { leaseMs: 10 * MINUTE };

/** Claims, delivers and drops every item `store` holds, at `now`. */
async function deliverAll(store: QueueStore, now: number) {
	for (;;) {
		const item = await store.claim({ owner: 'w', now, ...lease });
		if (!item) return;
		await store.complete(item.id, 'w', {
			now,
			recipients: item.recipients.map((r) => ({
				address: r.address,
				status: 'delivered' as const,
			})),
			nextAttemptAt: now,
			attempts: 1,
			delayNotified: false,
		});
	}
}

describeRedis('RedisQueueStore keys', (url) => {
	const { admin, client, create, prefix, prefixFor, share } =
		temporaryStores(url);

	test('every key a store writes is under its prefix, and a neighbour’s prefix is left alone', async () => {
		const base = prefix();
		const near = RedisQueueStore.open({
			client: client(),
			keyPrefix: `${base}item:`,
		});
		const store = RedisQueueStore.open({ client: client(), keyPrefix: base });
		const kept = await near.add(entry());
		const item = await store.add(entry());
		await store.claim({ owner: 'w', now: T0, ...lease });
		const keys = await keysUnder(admin, base);
		expect(keys.every((k) => k.startsWith(base))).toBe(true);
		expect(keys).toContain(`${base}item:${item.id}`);
		expect(keys).toContain(`${base}message:${item.id}`);
		// An id is only ever an item's: never another key under the prefix.
		for (const id of ['items', 'ready', '../items', `${item.id}x`, 'x']) {
			expect(await store.get(id)).toBeUndefined();
			expect(await store.cancel(id)).toBeUndefined();
		}
		await deliverAll(store, T0 + 10 * MINUTE);
		expect(await store.count()).toBe(0);
		expect(await near.get(kept.id)).toEqual(kept);
		expect(await keysUnder(admin, `${base}item:${item.id}`)).toEqual([]);
		expect(await keysUnder(admin, `${base}message:`)).toEqual([]);
	});

	test('a lone surrogate, which Bun would write as U+FFFD, and a NUL, which Redis would keep, are refused: nothing is stored', async () => {
		const store = create();
		await rejects(store.add(entry({ from: 'a\ud83d@example.net' })), 'INVALID');
		await rejects(
			store.add(entry({ to: ['jo\u0000e@example.com'] })),
			'INVALID',
		);
		await rejects(
			store.claim({ owner: 'w\udc00', now: T0, ...lease }),
			'INVALID',
		);
		expect(await store.count()).toBe(0);
		expect(await keysUnder(admin, `${prefixFor(store)}item:`)).toEqual([]);
		const item = await store.add(entry());
		await store.claim({ owner: 'w', now: T0, ...lease });
		await rejects(
			store.complete(item.id, 'w', {
				now: T0,
				recipients: [
					{
						address: 'joe@example.com',
						status: 'deferred',
						reply: { code: 451, text: 'cut at \ud83d' },
					},
				],
				nextAttemptAt: T0 + MINUTE,
				attempts: 1,
				delayNotified: false,
			}),
			'INVALID',
		);
		expect((await store.get(item.id))?.recipients[0]?.status).toBe('pending');
	});

	test('an expired lease and an item never claimed are taken in due order, across both sets', async () => {
		const store = create();
		const early = await store.add(entry({ createdAt: T0 }));
		await store.claim({ owner: 'crashed', now: T0, leaseMs: MINUTE });
		const later = await store.add(entry({ createdAt: T0 + MINUTE / 2 }));
		const now = T0 + 2 * MINUTE;
		expect((await store.claim({ owner: 'w', now, ...lease }))?.id).toBe(
			early.id,
		);
		expect((await store.claim({ owner: 'w', now, ...lease }))?.id).toBe(
			later.id,
		);
		// And the other way round: the item never claimed is due first.
		const other = create();
		const first = await other.add(entry({ createdAt: T0 }));
		const second = await other.add(entry({ createdAt: T0 + MINUTE }));
		await other.reschedule(first.id, T0 + 2 * MINUTE);
		await other.claim({ owner: 'crashed', now: T0 + 2 * MINUTE, leaseMs: 1 });
		const at = T0 + 3 * MINUTE;
		expect((await other.claim({ owner: 'w', now: at, ...lease }))?.id).toBe(
			second.id,
		);
		expect((await other.claim({ owner: 'w', now: at, ...lease }))?.id).toBe(
			first.id,
		);
	});

	test('an expired lease on an item moved later is not claimed before that time', async () => {
		const store = create();
		const item = await store.add(entry());
		await store.claim({ owner: 'crashed', now: T0, leaseMs: MINUTE });
		expect(await store.reschedule(item.id, T0 + 5 * MINUTE)).toBe(true);
		const at = T0 + 2 * MINUTE;
		expect(
			await store.claim({ owner: 'w', now: at, ...lease }),
		).toBeUndefined();
		const now = T0 + 5 * MINUTE;
		expect((await store.claim({ owner: 'w', now, ...lease }))?.id).toBe(
			item.id,
		);
	});

	test('maxItems holds across instances adding at once', async () => {
		const store = create();
		const instances = Array.from({ length: 8 }, () => share(store));
		const adds = instances.flatMap((s) =>
			Array.from({ length: 4 }, () => s.add(entry(), { maxItems: 10 })),
		);
		const settled = await Promise.allSettled(adds);
		const added = settled.filter((s) => s.status === 'fulfilled');
		expect(added.length).toBe(10);
		for (const s of settled) {
			if (s.status === 'rejected') {
				expect(s.reason).toMatchObject({ code: 'QUEUE_FULL' });
			}
		}
		expect(await store.count()).toBe(10);
	});

	test('times keep every digit, fractions of a millisecond included', async () => {
		const store = create();
		const createdAt = T0 + 0.123456789;
		const item = await store.add(entry({ createdAt }));
		const claimed = await store.claim({
			owner: 'w',
			now: createdAt,
			leaseMs: 1.5,
		});
		expect(claimed?.lease?.expiresAt).toBe(createdAt + 1.5);
		expect((await store.get(item.id))?.createdAt).toBe(createdAt);
		expect(
			await store.claim({ owner: 'v', now: createdAt + 1.4, ...lease }),
		).toBeUndefined();
	});
});
