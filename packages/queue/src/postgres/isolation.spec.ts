import { expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import type { QueueItem } from '../contract/types';
import { describePostgres, temporaryStores } from './databases.fixtures';

// Two instances whose clients default to a stricter isolation level, as an
// application's may: every write still runs at READ COMMITTED, so none
// fails with SQLSTATE 40001 and `maxItems` holds.

for (const level of ['repeatable read', 'serializable']) {
	describePostgres(`PostgresQueueStore, clients at ${level}`, (url) => {
		const { create, share } = temporaryStores(url, {
			default_transaction_isolation: level,
		});

		test('instances starting together migrate once', async () => {
			const store = create();
			const others = Array.from({ length: 4 }, () => share(store));
			await Promise.all([store, ...others].map((s) => s.migrate()));
			expect(await store.count()).toBe(0);
		});

		test('adds racing for the last places of maxItems: exactly the limit kept, the rest QUEUE_FULL', async () => {
			const a = create();
			const b = share(a);
			await Promise.all([a.migrate(), b.migrate()]);
			const results = await Promise.allSettled(
				Array.from({ length: 60 }, (_, i) =>
					(i % 2 ? a : b).add(entry({ to: [`r${i}@example.com`] }), {
						maxItems: 40,
					}),
				),
			);
			const refused = results.flatMap((r) =>
				r.status === 'rejected' ? [r.reason] : [],
			);
			expect(refused).toHaveLength(20);
			for (const reason of refused) {
				expect(reason).toMatchObject({ code: 'QUEUE_FULL' });
			}
			expect(await a.count()).toBe(40);
		});

		test('an outcome racing a renewal of the same lease, from two connections: neither fails', async () => {
			const a = create();
			const b = share(a);
			await Promise.all([a.migrate(), b.migrate()]);
			for (let round = 0; round < 30; round++) {
				const added = await a.add(entry({ to: [`r${round}@example.com`] }));
				const now = T0 + round;
				const item = await a.claim({ owner: 'w', now, leaseMs: MINUTE });
				expect(item?.id).toBe(added.id);
				const [renewed, done] = await Promise.all([
					b.renew(added.id, 'w', now + 2 * MINUTE),
					a.complete(added.id, 'w', {
						now,
						recipients: [
							{ address: `r${round}@example.com`, status: 'delivered' },
						],
						nextAttemptAt: now,
						attempts: 1,
						delayNotified: false,
					}),
				]);
				expect(typeof renewed).toBe('boolean');
				expect(done?.id).toBe(added.id);
			}
			expect(await a.count()).toBe(0);
		});

		test('claims, renewals, completes and reschedules racing on two instances: each item once, no failure', async () => {
			const a = create();
			const b = share(a);
			for (let i = 0; i < 40; i++) {
				await a.add(entry({ to: [`r${i}@example.com`] }));
			}
			await b.migrate();
			const stores = [a, b];
			const claimed = await Promise.all(
				Array.from({ length: 60 }, (_, i) =>
					stores[i % 2]
						?.claim({ owner: `w${i % 2}`, now: T0, leaseMs: MINUTE })
						.then((item) => (item ? { item, by: i % 2 } : undefined)),
				),
			);
			const held = claimed.filter(
				(c): c is { item: QueueItem; by: number } => c !== undefined,
			);
			expect(held).toHaveLength(40);
			expect(new Set(held.map((c) => c.item.id)).size).toBe(40);
			await Promise.all(
				held.map(async ({ item, by }, n) => {
					const store = stores[by];
					const owner = `w${by}`;
					expect(await store?.renew(item.id, owner, T0 + 2 * MINUTE)).toBe(
						true,
					);
					if (n % 4 === 0) {
						expect(await store?.reschedule(item.id, T0 + MINUTE, owner)).toBe(
							true,
						);
						return;
					}
					const done = await store?.complete(item.id, owner, {
						now: T0,
						recipients: item.recipients.map((r) => ({
							address: r.address,
							status: n % 2 ? 'delivered' : 'deferred',
						})),
						nextAttemptAt: T0 + MINUTE,
						attempts: 1,
						delayNotified: false,
					});
					expect(done?.id).toBe(item.id);
				}),
			);
			// The 10 given back and the 10 deferred are left; the 20 delivered are gone.
			expect(await a.count()).toBe(20);
			await Promise.all(
				(await a.list()).map((item, n) => (n % 2 ? a : b).cancel(item.id)),
			);
			expect(await b.count()).toBe(0);
		});
	});
}
