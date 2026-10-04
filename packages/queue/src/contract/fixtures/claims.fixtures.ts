import { describe, expect, test } from 'bun:test';
import type { AttemptResult } from '../types';
import {
	entry,
	MINUTE,
	rejects,
	type StoreFactories,
	T0,
} from './setup.fixtures';

const lease = { leaseMs: 10 * MINUTE };

const result = (overrides: Partial<AttemptResult> = {}): AttemptResult => ({
	now: T0 + MINUTE,
	recipients: [],
	nextAttemptAt: T0 + 30 * MINUTE,
	attempts: 1,
	delayNotified: false,
	...overrides,
});

/** Claims, leases and schedules. */
export function describeClaims(factories: StoreFactories): void {
	describe('claims and leases', () => {
		claiming(factories);
		leasing(factories);
		rescheduling(factories);
	});
}

function claiming({ create }: StoreFactories): void {
	test('claim takes a due item with a lease; nothing else is due', async () => {
		const store = await create();
		const item = await store.add(entry());
		const claimed = await store.claim({ owner: 'w1', now: T0, ...lease });
		expect(claimed?.id).toBe(item.id);
		expect(claimed?.lease).toEqual({
			owner: 'w1',
			expiresAt: T0 + 10 * MINUTE,
		});
		expect((await store.get(item.id))?.lease?.owner).toBe('w1');
		expect(
			await store.claim({ owner: 'w2', now: T0, ...lease }),
		).toBeUndefined();
	});

	test('an item not yet due is not claimed', async () => {
		const store = await create();
		await store.add(entry({ createdAt: T0 + MINUTE }));
		expect(
			await store.claim({ owner: 'w1', now: T0, ...lease }),
		).toBeUndefined();
		expect(
			await store.claim({ owner: 'w1', now: T0 + MINUTE, ...lease }),
		).toBeDefined();
	});

	test('the earliest due is claimed first, then the oldest', async () => {
		const store = await create();
		const late = await store.add(entry({ createdAt: T0 + MINUTE }));
		const first = await store.add(entry());
		const second = await store.add(entry());
		const now = T0 + MINUTE;
		const order = [];
		for (let i = 0; i < 3; i++) {
			order.push((await store.claim({ owner: 'w', now, ...lease }))?.id);
		}
		expect(order).toEqual([first.id, second.id, late.id]);
	});
}

function leasing({ create }: StoreFactories): void {
	test('an expired lease is claimed again, and its old owner has lost it', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'crashed', now: T0, leaseMs: MINUTE });
		expect(
			await store.claim({ owner: 'w2', now: T0 + MINUTE - 1, ...lease }),
		).toBeUndefined();
		const again = await store.claim({
			owner: 'w2',
			now: T0 + MINUTE,
			...lease,
		});
		expect(again?.id).toBe(item.id);
		expect(again?.lease?.owner).toBe('w2');
		expect(await store.renew(item.id, 'crashed', T0 + 5 * MINUTE)).toBe(false);
		expect(await store.complete(item.id, 'crashed', result())).toBeUndefined();
		expect(await store.reschedule(item.id, T0, 'crashed')).toBe(false);
		expect((await store.get(item.id))?.lease?.owner).toBe('w2');
	});

	test('renew moves the expiry while the owner holds the lease', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, leaseMs: MINUTE });
		expect(await store.renew(item.id, 'w1', T0 + 3 * MINUTE)).toBe(true);
		expect(
			await store.claim({ owner: 'w2', now: T0 + 2 * MINUTE, ...lease }),
		).toBeUndefined();
		expect(await store.renew('nope', 'w1', T0)).toBe(false);
	});
}

function rescheduling({ create }: StoreFactories): void {
	test('reschedule with the owner gives the item back, due at the new time', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, ...lease });
		expect(await store.reschedule(item.id, T0 + MINUTE, 'w2')).toBe(false);
		expect(await store.reschedule(item.id, T0 + MINUTE, 'w1')).toBe(true);
		const stored = await store.get(item.id);
		expect(stored?.lease).toBeUndefined();
		expect(stored?.nextAttemptAt).toBe(T0 + MINUTE);
		expect(stored?.attempts).toBe(0);
	});

	test('reschedule without an owner moves the time and leaves the lease alone', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, ...lease });
		await store.complete(item.id, 'w1', result());
		expect(await store.reschedule(item.id, T0 + MINUTE)).toBe(true);
		expect(
			(await store.claim({ owner: 'w2', now: T0 + MINUTE, ...lease }))?.id,
		).toBe(item.id);
		expect(await store.reschedule(item.id, T0)).toBe(true);
		expect((await store.get(item.id))?.lease?.owner).toBe('w2');
	});

	test('claim refuses a bad request', async () => {
		const store = await create();
		await rejects(store.claim({ owner: '', now: T0, ...lease }), 'INVALID');
		await rejects(store.claim({ owner: 'w', now: T0, leaseMs: 0 }), 'INVALID');
		await rejects(
			store.claim({ owner: 'w', now: Number.NaN, ...lease }),
			'INVALID',
		);
		await rejects(store.reschedule('nope', T0, ''), 'INVALID');
	});
}
