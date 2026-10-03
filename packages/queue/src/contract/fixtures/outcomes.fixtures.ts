import { describe, expect, test } from 'bun:test';
import type { AttemptResult } from '../types';
import { entry, MINUTE, type StoreFactories, T0 } from './setup.fixtures';

const lease = { leaseMs: 10 * MINUTE };

const result = (overrides: Partial<AttemptResult> = {}): AttemptResult => ({
	now: T0 + MINUTE,
	recipients: [],
	nextAttemptAt: T0 + 30 * MINUTE,
	attempts: 1,
	delayNotified: false,
	...overrides,
});

/** What `complete` records. */
export function describeOutcomes(factories: StoreFactories): void {
	describe('outcomes', () => {
		recording(factories);
		finality(factories);
	});
}

function recording({ create }: StoreFactories): void {
	test('complete records each outcome, the schedule, and lets go of the lease', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, ...lease });
		const reply = {
			code: 451,
			status: '4.3.0',
			text: 'try later',
			host: 'mx.example.com',
		};
		const done = await store.complete(
			item.id,
			'w1',
			result({
				recipients: [{ address: 'joe@example.com', status: 'deferred', reply }],
			}),
		);
		expect(done?.recipients).toEqual([
			{
				address: 'joe@example.com',
				status: 'deferred',
				reply,
				updatedAt: T0 + MINUTE,
			},
			{ address: 'ann@example.org', status: 'pending' },
		]);
		const stored = await store.get(item.id);
		expect(stored).toEqual(done);
		expect(stored).toMatchObject({
			nextAttemptAt: T0 + 30 * MINUTE,
			attempts: 1,
		});
		expect(stored?.lease).toBeUndefined();
		expect(
			await store.claim({ owner: 'w2', now: T0 + 29 * MINUTE, ...lease }),
		).toBeUndefined();
		expect(
			await store.claim({ owner: 'w2', now: T0 + 30 * MINUTE, ...lease }),
		).toBeDefined();
	});

	test('an item whose every recipient is final is dropped with its message', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, ...lease });
		const done = await store.complete(
			item.id,
			'w1',
			result({
				recipients: [
					{
						address: 'joe@example.com',
						status: 'delivered',
						reply: { code: 250, text: 'ok' },
					},
					{
						address: 'ann@example.org',
						status: 'failed',
						reply: { code: 550, text: 'no' },
					},
				],
				delayNotified: true,
			}),
		);
		expect(done?.recipients.map((r) => r.status)).toEqual([
			'delivered',
			'failed',
		]);
		expect(done?.delayNotified).toBe(true);
		expect(await store.get(item.id)).toBeUndefined();
		expect(await store.readMessage(item.id)).toBeUndefined();
		expect(await store.count()).toBe(0);
	});
}

function finality({ create }: StoreFactories): void {
	test('a final state is never changed by a later outcome', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, ...lease });
		await store.complete(
			item.id,
			'w1',
			result({
				recipients: [{ address: 'joe@example.com', status: 'delivered' }],
			}),
		);
		await store.claim({ owner: 'w1', now: T0 + 30 * MINUTE, ...lease });
		const after = await store.complete(
			item.id,
			'w1',
			result({
				recipients: [{ address: 'joe@example.com', status: 'failed' }],
				attempts: 2,
			}),
		);
		expect(after?.recipients[0]?.status).toBe('delivered');
	});
}
