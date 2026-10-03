import { describe, expect, test } from 'bun:test';
import {
	bytes,
	entry,
	MINUTE,
	rejects,
	type StoreFactories,
	T0,
} from './setup.fixtures';

/** Adding, reading, listing and cancelling items. */
export function describeItems(factories: StoreFactories): void {
	describe('items', () => {
		adding(factories);
		listing(factories);
	});
}

function adding({ create }: StoreFactories): void {
	test('add keeps the envelope, every recipient pending, due at once', async () => {
		const store = await create();
		const item = await store.add(entry());
		expect(item).toMatchObject({
			from: 'mary@example.net',
			recipients: [
				{ address: 'joe@example.com', status: 'pending' },
				{ address: 'ann@example.org', status: 'pending' },
			],
			size: 22,
			createdAt: T0,
			nextAttemptAt: T0,
			attempts: 0,
			delayNotified: false,
		});
		expect(item.lease).toBeUndefined();
		expect(await store.get(item.id)).toEqual(item);
		expect(await store.count()).toBe(1);
	});

	test('the null sender is kept as the empty string', async () => {
		const store = await create();
		const item = await store.add(entry({ from: '' }));
		expect((await store.get(item.id))?.from).toBe('');
	});

	test('readMessage gives the bytes back, a copy each time', async () => {
		const store = await create();
		const message = bytes('Subject: x\r\n\r\nbody\r\n');
		const item = await store.add(entry({ message }));
		message[0] = 0;
		const read = await store.readMessage(item.id);
		expect(new TextDecoder().decode(read)).toBe('Subject: x\r\n\r\nbody\r\n');
		if (read) read[0] = 0;
		expect((await store.readMessage(item.id))?.[0]).toBe(83);
	});

	test('an item returned is a copy', async () => {
		const store = await create();
		const item = await store.add(entry());
		const first = (item.recipients as unknown as { status: string }[])[0];
		if (first) first.status = 'failed';
		expect((await store.get(item.id))?.recipients[0]?.status).toBe('pending');
	});

	test('an unknown id is undefined, not an error', async () => {
		const store = await create();
		expect(await store.get('nope')).toBeUndefined();
		expect(await store.readMessage('nope')).toBeUndefined();
		expect(await store.cancel('nope')).toBeUndefined();
		expect(await store.reschedule('nope', T0)).toBe(false);
	});
}

function listing({ create }: StoreFactories): void {
	test('list gives the next due first, then the oldest, a page at a time', async () => {
		const store = await create();
		const a = await store.add(entry({ createdAt: T0 + 2 * MINUTE }));
		const b = await store.add(entry({ createdAt: T0 }));
		const c = await store.add(entry({ createdAt: T0 }));
		const ids = (await store.list()).map((i) => i.id);
		expect(ids).toEqual([b.id, c.id, a.id]);
		const page = await store.list({ offset: 1, limit: 1 });
		expect(page.map((i) => i.id)).toEqual([c.id]);
	});

	test('list refuses a bad page', async () => {
		const store = await create();
		await rejects(store.list({ limit: 0 }), 'INVALID');
		await rejects(store.list({ offset: -1 }), 'INVALID');
	});

	test('cancel drops the item and its message, leased or not', async () => {
		const store = await create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w1', now: T0, leaseMs: MINUTE });
		const cancelled = await store.cancel(item.id);
		expect(cancelled?.id).toBe(item.id);
		expect(await store.get(item.id)).toBeUndefined();
		expect(await store.readMessage(item.id)).toBeUndefined();
		expect(await store.count()).toBe(0);
	});

	test('maxItems refuses an add past the limit with QUEUE_FULL', async () => {
		const store = await create();
		await store.add(entry(), { maxItems: 2 });
		await store.add(entry(), { maxItems: 2 });
		await rejects(store.add(entry(), { maxItems: 2 }), 'QUEUE_FULL');
		expect(await store.count()).toBe(2);
		await rejects(store.add(entry(), { maxItems: 0 }), 'INVALID');
	});

	test('add refuses what is not an item', async () => {
		const store = await create();
		await rejects(store.add(entry({ to: [] })), 'INVALID');
		await rejects(
			store.add(entry({ message: 'text' as unknown as Uint8Array })),
			'INVALID',
		);
		await rejects(store.add(entry({ createdAt: Number.NaN })), 'INVALID');
	});
}
