import { describe, expect, test } from 'bun:test';
import {
	entry,
	MINUTE,
	rejects,
	T0,
} from '../contract/fixtures/setup.fixtures';
import { bytesOf, CHUNK, chunksOf, messageOf } from './documents';
import { describeMongo, temporaryStores } from './servers.fixtures';

const lease = { leaseMs: 10 * MINUTE };

describe('a message in chunks', () => {
	test('is cut at CHUNK bytes and put back together, in order, only whole', () => {
		const message = Uint8Array.from(
			{ length: 2 * CHUNK + 17 },
			(_, i) => i % 251,
		);
		const chunks = chunksOf('id', message);
		expect(chunks.map((c) => [c['_id'], c['n']])).toEqual([
			['id:0', 0],
			['id:1', 1],
			['id:2', 2],
		]);
		expect(messageOf(chunks, message.length)).toEqual(message);
		expect(messageOf(chunks.slice(0, 2), message.length)).toBeUndefined();
		expect(
			messageOf([chunks[1], chunks[0], chunks[2]] as never, message.length),
		).toBeUndefined();
		expect(messageOf(chunks, message.length - 1)).toBeUndefined();
		expect(chunksOf('id', new Uint8Array(0))).toEqual([]);
		expect(messageOf([], 0)).toEqual(new Uint8Array(0));
	});

	test('reads the bytes of a driver Binary up to its position, of a Buffer, and of nothing else', () => {
		const buffer = Uint8Array.of(1, 2, 3, 0, 0);
		expect(bytesOf({ buffer, position: 3 })).toEqual(Uint8Array.of(1, 2, 3));
		expect(bytesOf(Buffer.from([4, 5]))).toEqual(Uint8Array.of(4, 5));
		for (const data of [null, 'abc', 3, { buffer: [1], position: 1 }, {}]) {
			expect(bytesOf(data)).toBeUndefined();
		}
	});
});

describeMongo('MongoQueueStore documents', (url) => {
	const { admin, create, prefixFor } = temporaryStores(url);

	test('a message larger than a document holds is kept in chunks, byte for byte; an empty one too', async () => {
		const store = create();
		const big = Uint8Array.from(
			{ length: 4 * CHUNK + 3 },
			(_, i) => (i * 31) % 256,
		);
		const item = await store.add(entry({ message: big }));
		const empty = await store.add(entry({ message: new Uint8Array(0) }));
		expect(await store.readMessage(item.id)).toEqual(big);
		expect(await store.readMessage(empty.id)).toEqual(new Uint8Array(0));
		const chunks = admin.collection(`${prefixFor(store)}messages`);
		expect(await chunks.countDocuments({ item: item.id })).toBe(5);
		expect(await chunks.countDocuments({ item: empty.id })).toBe(0);
		await store.cancel(item.id);
		expect(await chunks.countDocuments({})).toBe(0);
		expect(await store.readMessage(item.id)).toBeUndefined();
	}, 30_000);

	test('a lone surrogate, which the driver would write as U+FFFD, and a NUL are refused: nothing is stored', async () => {
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
		await rejects(
			store.claim({ owner: 'w\u0000', now: T0, ...lease }),
			'INVALID',
		);
		expect(await store.count()).toBe(0);
		expect(
			await admin.collection(`${prefixFor(store)}messages`).countDocuments({}),
		).toBe(0);
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
		await rejects(store.renew(item.id, 'w\u0000', T0 + MINUTE), 'INVALID');
		await rejects(store.reschedule(item.id, T0, 'w\ud800'), 'INVALID');
		expect(await store.reschedule('x\u0000', T0, 'w\ud800')).toBe(false);
		expect((await store.get(item.id))?.recipients[0]?.status).toBe('pending');
	});

	test('text the other stores keep is kept as it was: emoji, quotes, $ and dots', async () => {
		const store = create();
		const from = '"o\'brien.$x"@example.net';
		const to = ['😀@例え.jp', 'a.b$c@example.com'];
		const item = await store.add(entry({ from, to }));
		await store.claim({ owner: 'w.$', now: T0, ...lease });
		const done = await store.complete(item.id, 'w.$', {
			now: T0,
			recipients: [
				{
					address: '😀@例え.jp',
					status: 'deferred',
					reply: {
						code: 451,
						status: '4.3.0',
						text: '{ "$set": 1 } 😀',
						host: 'mx.例え.jp',
					},
				},
			],
			nextAttemptAt: T0 + MINUTE,
			attempts: 1,
			delayNotified: false,
		});
		expect(await store.get(item.id)).toEqual(done);
		expect(done?.from).toBe(from);
		expect(done?.recipients[0]?.reply?.text).toBe('{ "$set": 1 } 😀');
	});

	test('an id that is not one the store made never reaches a filter: an object included', async () => {
		const store = create();
		const item = await store.add(entry());
		for (const id of [
			{ $ne: null },
			{ $gt: '' },
			`${item.id}:0`,
			`${item.id}x`,
			'layout',
			'seq',
			'',
		] as unknown as string[]) {
			expect(await store.get(id)).toBeUndefined();
			expect(await store.readMessage(id)).toBeUndefined();
			expect(await store.cancel(id)).toBeUndefined();
			expect(await store.renew(id, 'w', T0)).toBe(false);
			expect(await store.reschedule(id, T0)).toBe(false);
		}
		expect(await store.count()).toBe(1);
	});

	test('an expired lease and an item never claimed are taken in due order, then the oldest first', async () => {
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
		// Equally due: in the order added, an expired lease no earlier than the rest.
		const third = create();
		const ids = [];
		for (let i = 0; i < 5; i++) ids.push((await third.add(entry())).id);
		await third.claim({ owner: 'crashed', now: T0, leaseMs: 1 });
		const order = [];
		for (let i = 0; i < 5; i++) {
			order.push(
				(await third.claim({ owner: 'w', now: T0 + 1, ...lease }))?.id,
			);
		}
		expect(order).toEqual(ids);
	});

	test('an expired lease on an item moved later is not claimed before that time', async () => {
		const store = create();
		const item = await store.add(entry());
		await store.claim({ owner: 'crashed', now: T0, leaseMs: MINUTE });
		expect(await store.reschedule(item.id, T0 + 5 * MINUTE)).toBe(true);
		expect(
			await store.claim({ owner: 'w', now: T0 + 2 * MINUTE, ...lease }),
		).toBeUndefined();
		const now = T0 + 5 * MINUTE;
		expect((await store.claim({ owner: 'w', now, ...lease }))?.id).toBe(
			item.id,
		);
	});

	test('times keep every digit, fractions of a millisecond and the far future included', async () => {
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
		const far = 8.64e15; // the last time a Date holds
		expect(await store.reschedule(item.id, far)).toBe(true);
		expect((await store.get(item.id))?.nextAttemptAt).toBe(far);
		expect(await store.reschedule(item.id, -1.5)).toBe(true);
		expect((await store.get(item.id))?.nextAttemptAt).toBe(-1.5);
	});
});
