import { expect, test } from 'bun:test';
import { entry } from '../contract/fixtures/setup.fixtures';
import type { QueueStore } from '../contract/queue-store';
import type { MongoQueueCollection, MongoQueueDb } from './options';
import { describeMongo, temporaryStores } from './servers.fixtures';
import { MongoQueueStore } from './store';

/** Eight instances, each adding four items at once with `maxItems`; the outcome of each add. */
async function race(
	store: QueueStore,
	share: (s: QueueStore) => QueueStore,
	maxItems: number,
) {
	const instances = Array.from({ length: 8 }, () => share(store));
	// Each connected and set up first, so the adds race and not the connections.
	await Promise.all(instances.map((s) => s.count()));
	const settled = await Promise.allSettled(
		instances.flatMap((s) =>
			Array.from({ length: 4 }, () => s.add(entry(), { maxItems })),
		),
	);
	for (const s of settled) {
		if (s.status === 'rejected') {
			expect(s.reason).toMatchObject({ code: 'QUEUE_FULL' });
		}
	}
	return settled.filter((s) => s.status === 'fulfilled').length;
}

describeMongo('MongoQueueStore maxItems', (url) => {
	const { admin, create, db, prefixFor, share } = temporaryStores(url);

	test('maxItems holds across 8 instances adding at once', async () => {
		const store = create();
		expect(await race(store, share, 10)).toBe(10);
		expect(await store.count()).toBe(10);
		const places = await admin
			.collection(`${prefixFor(store)}items`)
			.distinct('slot');
		expect(places.sort((a, b) => a - b)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
	});

	test('maxItems holds across 8 instances on a queue with places freed here and there', async () => {
		const store = create();
		const added = [];
		for (let i = 0; i < 10; i++)
			added.push(await store.add(entry(), { maxItems: 10 }));
		for (const item of added.filter((_, i) => i % 3 !== 0))
			await store.cancel(item.id);
		expect(await store.count()).toBe(4);
		expect(await race(store, share, 10)).toBe(6);
		expect(await store.count()).toBe(10);
		// Each one refused said how many there were, and none was left written.
		expect(
			await admin.collection(`${prefixFor(store)}messages`).countDocuments({}),
		).toBe(10);
	});

	test('a place is free again with its item, and the lowest free one is found when the next ones are held', async () => {
		const store = create();
		const items = admin.collection(`${prefixFor(store)}items`);
		const added = [];
		for (let i = 0; i < 5; i++)
			added.push(await store.add(entry(), { maxItems: 100 }));
		// Sequence numbers 1 to 5: places 1 to 5. Back to 1, the next four
		// draws (2 to 5) find their places held, and place 0 is the lowest free.
		await admin
			.collection(`${prefixFor(store)}schema`)
			.updateOne({ _id: 'seq' as never }, { $set: { n: 1 } });
		const next = await store.add(entry(), { maxItems: 100 });
		expect((await items.findOne({ _id: next.id as never }))?.['slot']).toBe(0);
		const [first] = added;
		await store.cancel(first?.id as string);
		await admin
			.collection(`${prefixFor(store)}schema`)
			.updateOne({ _id: 'seq' as never }, { $set: { n: 0 } });
		const again = await store.add(entry(), { maxItems: 100 });
		expect((await items.findOne({ _id: again.id as never }))?.['slot']).toBe(1);
	});

	test('items added without maxItems count toward it, and take no place', async () => {
		const store = create();
		await store.add(entry());
		await store.add(entry());
		await expect(store.add(entry(), { maxItems: 2 })).rejects.toMatchObject({
			code: 'QUEUE_FULL',
			message: 'The queue holds 2 items, its limit',
		});
		expect(await store.count()).toBe(2);
		expect(await store.add(entry(), { maxItems: 3 })).toBeDefined();
		expect(
			await admin
				.collection(`${prefixFor(store)}items`)
				.countDocuments({ slot: { $exists: true } }),
		).toBe(1);
		expect(
			await admin.collection(`${prefixFor(store)}messages`).countDocuments({}),
		).toBe(3);
	});

	test('the lowest free place is found above the places held below it', async () => {
		const store = create();
		const items = admin.collection(`${prefixFor(store)}items`);
		for (let i = 0; i < 6; i++) await store.add(entry(), { maxItems: 100 });
		// Sequence numbers 1 to 6: places 1 to 6. Place 3's item moved to 0,
		// and a document holding 7: places 0 to 7 held, but 3.
		await items.updateOne({ slot: 3 }, { $set: { slot: 0 } });
		await items.insertOne({
			_id: 'x' as never,
			slot: 7,
			nextAttemptAt: 1e300,
			seq: 0,
		});
		// Back to 3: the draws 4 to 7 are all held, and the index gives 3.
		await admin
			.collection(`${prefixFor(store)}schema`)
			.updateOne({ _id: 'seq' as never }, { $set: { n: 3 } });
		const next = await store.add(entry(), { maxItems: 100 });
		expect((await items.findOne({ _id: next.id as never }))?.['slot']).toBe(3);
	});

	test('an add that loses its place every time is refused as full, with the count it read', async () => {
		const other = create();
		await other.add(entry(), { maxItems: 10 });
		const real = db();
		const losing: MongoQueueDb = {
			collection(name, options) {
				const c = real.collection(
					name,
					options,
				) as unknown as MongoQueueCollection;
				if (!name.endsWith('items')) return c;
				// As the driver says it when it gives no keyPattern.
				return Object.assign(Object.create(c), {
					insertOne: () =>
						Promise.reject(
							Object.assign(
								new Error(
									'E11000 duplicate key error collection: q index: bumail_slot dup key: { slot: 1 }',
								),
								{ code: 11000 },
							),
						),
				});
			},
		};
		const store = MongoQueueStore.open({
			db: losing,
			collectionPrefix: prefixFor(other),
		});
		await expect(store.add(entry(), { maxItems: 10 })).rejects.toMatchObject({
			code: 'QUEUE_FULL',
			message: 'The queue holds 1 items, its limit',
		});
		expect(await other.count()).toBe(1);
		expect(
			await admin.collection(`${prefixFor(other)}messages`).countDocuments({}),
		).toBe(1);
	});
});
