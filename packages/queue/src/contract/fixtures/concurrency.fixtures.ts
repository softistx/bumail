import { describe, expect, test } from 'bun:test';
import type { QueueStore } from '../queue-store';
import { entry, MINUTE, type StoreFactories, T0 } from './setup.fixtures';

const delivered = (now: number) => ({
	now,
	recipients: [
		{ address: 'joe@example.com', status: 'delivered' as const },
		{ address: 'ann@example.org', status: 'delivered' as const },
	],
	nextAttemptAt: now,
	attempts: 1,
	delayNotified: false,
});

/** A worker: claims and delivers until nothing is due, yielding between steps. */
async function work(store: QueueStore, owner: string, now: number) {
	const taken: string[] = [];
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
		const item = await store.claim({ owner, now, leaseMs: 10 * MINUTE });
		if (!item) return taken;
		taken.push(item.id);
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
		const done = await store.complete(item.id, owner, delivered(now));
		expect(done).toBeDefined();
	}
}

/** Several claimers on one queue, and a claimer that crashed. */
export function describeConcurrency({ create, share }: StoreFactories): void {
	describe('several workers', () => {
		test('many claimers race: every item is delivered once', async () => {
			const store = await create();
			const ids = new Set<string>();
			for (let i = 0; i < 60; i++) ids.add((await store.add(entry())).id);
			const workers = Array.from({ length: 8 }, (_, i) =>
				work(share(store), `w${i}`, T0),
			);
			const taken = (await Promise.all(workers)).flat();
			expect(taken.length).toBe(60);
			expect(new Set(taken)).toEqual(ids);
			expect(await store.count()).toBe(0);
		});

		test('a crashed worker’s items are claimed again once its leases expire', async () => {
			const store = await create();
			for (let i = 0; i < 5; i++) await store.add(entry());
			const crashed: string[] = [];
			for (let i = 0; i < 5; i++) {
				const item = await store.claim({
					owner: 'crashed',
					now: T0,
					leaseMs: MINUTE,
				});
				if (item) crashed.push(item.id);
			}
			expect(crashed.length).toBe(5);
			const other = share(store);
			expect(await work(other, 'w2', T0 + MINUTE - 1)).toEqual([]);
			const recovered = await work(other, 'w2', T0 + MINUTE);
			expect(new Set(recovered)).toEqual(new Set(crashed));
			for (const id of crashed) {
				expect(
					await store.complete(id, 'crashed', delivered(T0)),
				).toBeUndefined();
			}
			expect(await store.count()).toBe(0);
		});
	});
}
