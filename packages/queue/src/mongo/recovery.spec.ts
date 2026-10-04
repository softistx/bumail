import { expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import type { MongoQueueCollection, MongoQueueDb } from './options';
import { describeMongo, temporaryStores } from './servers.fixtures';
import { MongoQueueStore } from './store';

const lease = { leaseMs: MINUTE };

const delivered = {
	now: T0,
	recipients: [
		{ address: 'joe@example.com', status: 'delivered' as const },
		{ address: 'ann@example.org', status: 'delivered' as const },
	],
	nextAttemptAt: T0 + MINUTE,
	attempts: 1,
	delayNotified: false,
};

describeMongo('MongoQueueStore when something went wrong', (url) => {
	const { admin, db, create, prefix, prefixFor, share } = temporaryStores(url);
	const collection = (store: MongoQueueStore, name: string) =>
		admin.collection(`${prefixFor(store)}${name}`);

	test('a dangling message, left by an instance that died between two writes, is never read, nor counted', async () => {
		const store = create();
		const kept = await store.add(entry());
		const gone = await store.add(entry());
		const chunks = await collection(store, 'messages')
			.find({ item: gone.id })
			.toArray();
		await store.cancel(gone.id);
		// The item's delete went through; the chunks' did not.
		await collection(store, 'messages').insertMany(chunks);
		expect(await store.readMessage(gone.id)).toBeUndefined();
		expect(await store.get(gone.id)).toBeUndefined();
		expect(await store.count()).toBe(1);
		expect((await store.list()).map((i) => i.id)).toEqual([kept.id]);
		expect(await store.readMessage(kept.id)).toEqual(entry().message);
		// And as an add cut short leaves them: chunks no item was written for.
		await collection(store, 'messages').insertOne({
			_id: `${crypto.randomUUID()}:0` as never,
			item: 'none',
			n: 0,
			data: new Uint8Array(8),
		});
		expect(await store.count()).toBe(1);
		const claimed = await store.claim({ owner: 'w', now: T0, ...lease });
		expect(claimed?.id).toBe(kept.id);
	});

	test('an item whose message is damaged — a chunk gone, or not bytes — reads as no message', async () => {
		const store = create();
		const message = new Uint8Array(5 * 1024 * 1024).fill(7);
		const cut = await store.add(entry({ message }));
		await collection(store, 'messages').deleteOne({
			_id: `${cut.id}:1` as never,
		});
		expect(await store.readMessage(cut.id)).toBeUndefined();
		const odd = await store.add(entry());
		await collection(store, 'messages').updateOne(
			{ _id: `${odd.id}:0` as never },
			{ $set: { data: 'Subject: Hi' } },
		);
		expect(await store.readMessage(odd.id)).toBeUndefined();
		const short = await store.add(entry());
		await collection(store, 'items').updateOne(
			{ _id: short.id as never },
			{ $inc: { size: 1 } },
		);
		expect(await store.readMessage(short.id)).toBeUndefined();
		// The items themselves are still there, to cancel.
		expect(await store.count()).toBe(3);
		for (const item of [cut, odd, short]) await store.cancel(item.id);
		expect(await collection(store, 'messages').countDocuments({})).toBe(0);
	});

	test('complete records nothing on a document with no rev, damaged by hand, and returns at once', async () => {
		const store = create();
		const item = await store.add(entry());
		await store.claim({ owner: 'w', now: T0, ...lease });
		await collection(store, 'items').updateOne(
			{ _id: item.id as never },
			{ $unset: { rev: '' } },
		);
		expect(await store.complete(item.id, 'w', delivered)).toBeUndefined();
		const kept = await store.get(item.id);
		expect(kept?.attempts).toBe(0);
		expect(kept?.lease?.owner).toBe('w');
	}, 2000);

	test('a document damaged by hand — its due time a string — is never claimed, and the others are', async () => {
		const store = create();
		const damaged = await store.add(entry());
		const kept = await store.add(entry({ createdAt: T0 + 1 }));
		await collection(store, 'items').updateOne(
			{ _id: damaged.id as never },
			{ $set: { nextAttemptAt: String(T0) } },
		);
		const later = T0 + 10 * MINUTE;
		expect((await store.claim({ owner: 'w', now: later, ...lease }))?.id).toBe(
			kept.id,
		);
		expect(
			await store.claim({ owner: 'w', now: later, ...lease }),
		).toBeUndefined();
		expect((await store.cancel(damaged.id))?.id).toBe(damaged.id);
	});

	test('a sequence counter that is not a whole number is refused, saying where; nothing is stored', async () => {
		const store = create();
		await store.count();
		const schema = collection(store, 'schema');
		await schema.updateOne(
			{ _id: 'seq' as never },
			{ $set: { n: 1.5 } },
			{ upsert: true },
		);
		await expect(store.add(entry())).rejects.toMatchObject({
			code: 'INVALID',
			message: `The collection ${prefixFor(store)}schema holds a sequence that is not a number`,
		});
		// One MongoDB cannot add to at all: its own error, as it said it.
		await schema.updateOne({ _id: 'seq' as never }, { $set: { n: 'one' } });
		await expect(store.add(entry())).rejects.toThrow(
			'Cannot apply $inc to a value of non-numeric type',
		);
		expect(await store.count()).toBe(0);
		expect(await collection(store, 'messages').countDocuments({})).toBe(0);
	});

	test('complete reads the item again when another outcome was recorded since it read it', async () => {
		const other = create();
		const item = await other.add(entry());
		await other.claim({ owner: 'w', now: T0, ...lease });
		const real = db();
		let armed = true;
		// Between complete's read and its write, the same owner records an
		// outcome and claims the item again, on another handle.
		const racing: MongoQueueDb = {
			collection(name, options) {
				const c = real.collection(
					name,
					options,
				) as unknown as MongoQueueCollection;
				if (!name.endsWith('items')) return c;
				return Object.assign(Object.create(c), {
					async findOne(...args: Parameters<MongoQueueCollection['findOne']>) {
						const doc = await c.findOne(...args);
						if (armed && args[1] === undefined) {
							armed = false;
							await other.complete(item.id, 'w', {
								now: T0,
								recipients: [
									{ address: 'joe@example.com', status: 'delivered' },
								],
								nextAttemptAt: T0 + MINUTE,
								attempts: 1,
								delayNotified: false,
							});
							await other.claim({ owner: 'w', now: T0 + MINUTE, ...lease });
						}
						return doc;
					},
				}) as MongoQueueCollection;
			},
		};
		const store = MongoQueueStore.open({
			db: racing,
			collectionPrefix: prefixFor(other),
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

	test('an add whose item cannot be written takes its message back', async () => {
		const other = create();
		await other.count();
		const real = db();
		const failing: MongoQueueDb = {
			collection(name, options) {
				const c = real.collection(
					name,
					options,
				) as unknown as MongoQueueCollection;
				if (!name.endsWith('items')) return c;
				return Object.assign(Object.create(c), {
					insertOne: () => Promise.reject(new Error('connection reset')),
				}) as MongoQueueCollection;
			},
		};
		const store = MongoQueueStore.open({
			db: failing,
			collectionPrefix: prefixFor(other),
		});
		const big = new Uint8Array(9 * 1024 * 1024).fill(1);
		await expect(store.add(entry({ message: big }))).rejects.toThrow(
			'connection reset',
		);
		expect(await other.count()).toBe(0);
		expect(await collection(other, 'messages').countDocuments({})).toBe(0);
	});

	test('a lease another instance took since the read is not recorded over', async () => {
		const store = create();
		const item = await store.add(entry());
		await store.claim({ owner: 'stalled', now: T0, leaseMs: 1 });
		const other = share(store);
		await other.claim({ owner: 'other', now: T0 + 1, ...lease });
		expect(await store.complete(item.id, 'stalled', delivered)).toBeUndefined();
		expect(await store.renew(item.id, 'stalled', T0 + MINUTE)).toBe(false);
		expect(await store.reschedule(item.id, T0, 'stalled')).toBe(false);
		expect((await other.get(item.id))?.lease?.owner).toBe('other');
		expect(await other.complete(item.id, 'other', delivered)).toBeDefined();
		expect(await other.count()).toBe(0);
		expect(await collection(store, 'messages').countDocuments({})).toBe(0);
	});

	test('a prefix is a queue of its own: a neighbour’s collections are left alone', async () => {
		const base = prefix();
		const near = MongoQueueStore.open({
			db: db(),
			collectionPrefix: `${base}x_`,
		});
		const store = MongoQueueStore.open({ db: db(), collectionPrefix: base });
		const kept = await near.add(entry());
		const item = await store.add(entry());
		await store.claim({ owner: 'w', now: T0, ...lease });
		await store.complete(item.id, 'w', delivered);
		expect(await store.count()).toBe(0);
		expect(await near.get(kept.id)).toEqual(kept);
		expect(await near.readMessage(kept.id)).toEqual(entry().message);
		await near.cancel(kept.id);
		for (const c of ['items', 'messages', 'schema']) {
			await admin.collection(`${base}x_${c}`).drop();
		}
	});
});
