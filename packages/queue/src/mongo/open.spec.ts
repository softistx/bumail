import { describe, expect, test } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import { LAYOUT } from './layout';
import type { MongoQueueCollection, MongoQueueDb } from './options';
import { describeMongo, temporaryStores } from './servers.fixtures';
import { MongoQueueStore } from './store';

// A `Db` of the mongodb driver is what the store takes, though its type
// names none: a change on either side that breaks the fit fails typecheck
// here.
const fits = (db: Db): MongoQueueDb => db;

const NEEDS =
	'A MongoDB queue store needs db: a Db of the mongodb driver, or an object of its shape';

/** A database whose every call fails with `reason`, from a client that holds `password`. */
function failing(reason: string, password: string): MongoQueueDb {
	const fail = () => Promise.reject(new Error(reason));
	const collection = {
		findOne: fail,
		find: () => ({ toArray: fail }),
		insertOne: fail,
		insertMany: fail,
		findOneAndUpdate: fail,
		findOneAndDelete: fail,
		deleteMany: fail,
		countDocuments: fail,
		createIndex: fail,
	} satisfies MongoQueueCollection;
	return Object.assign(
		{ collection: () => collection },
		{ client: { options: { credentials: { password } } } },
	);
}

describe('MongoQueueStore.open', () => {
	test('refuses what is not a Db, never echoing a URL given in its place', () => {
		const open = (options: unknown) => () =>
			MongoQueueStore.open(options as { db: MongoQueueDb });
		for (const options of [
			undefined,
			null,
			'mongodb://root:secret@localhost/q',
			{},
			{ db: undefined },
			{ db: null },
			{ db: 'mongodb://root:secret@localhost/q' },
			{ db: new URL('mongodb://root:secret@localhost/q') },
			{ db: {} },
			{ db: { collection: 'items' } },
			{ db: () => {} },
		]) {
			expect(open(options)).toThrow(NEEDS);
			expect(open(options)).toThrow(
				expect.objectContaining({ code: 'INVALID' }),
			);
			expect(open(options)).not.toThrow('secret');
		}
	});

	test('refuses a url, beside db or alone, never repeating it', () => {
		const url = 'mongodb://root:secret@localhost/q';
		for (const options of [{ url }, { db: failing('unused', ''), url }]) {
			const open = () => MongoQueueStore.open(options as never);
			expect(open).toThrow(
				'A MongoDB queue store takes db, not url: give it client.db() of a MongoClient of yours',
			);
			expect(open).not.toThrow('secret');
		}
	});

	test('refuses a collection prefix that is not a plain name', () => {
		const db = failing('unused', '');
		for (const collectionPrefix of [
			'Queue_',
			'1q_',
			'q-',
			'q.',
			'system.',
			'q$',
			'$q',
			'q ',
			'q\r\n',
			'q\u0000',
			'q\ud83d',
			'é_',
			'',
			'x'.repeat(41),
		]) {
			expect(() => MongoQueueStore.open({ db, collectionPrefix })).toThrow(
				`collectionPrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not ${JSON.stringify(collectionPrefix)}`,
			);
		}
		for (const collectionPrefix of [7, {}, ['q_'], true]) {
			expect(() =>
				MongoQueueStore.open({
					db,
					collectionPrefix: collectionPrefix as unknown as string,
				}),
			).toThrow('collectionPrefix must be');
		}
	});

	test('a db whose collection() throws is INVALID, its password masked', () => {
		const db = Object.assign(
			{
				collection: (): never => {
					throw new Error('bad namespace for root:hunter2');
				},
			},
			{ client: { options: { credentials: { password: 'hunter2' } } } },
		);
		const open = () => MongoQueueStore.open({ db });
		expect(open).toThrow(
			"db cannot give the queue's collections: bad namespace for root:…",
		);
		expect(open).not.toThrow('hunter2');
	});

	test('a client whose getters throw is still taken: nothing to mask', () => {
		const db = {
			collection: failing('unused', '').collection,
			get client(): never {
				throw new Error('no client');
			},
		};
		expect(() => MongoQueueStore.open({ db })).not.toThrow();
	});

	test('connects to nothing until used; a failure to set up is INVALID, the password masked, and tried again', async () => {
		const store = MongoQueueStore.open({
			db: failing('Authentication failed for root:p%zz@db.example', 'p%zz'),
		});
		const first = store.count();
		await expect(first).rejects.toMatchObject({
			code: 'INVALID',
			message:
				'The MongoDB queue cannot be set up: Authentication failed for root:…@db.example',
		});
		await expect(store.add(entry())).rejects.toMatchObject({
			code: 'INVALID',
		});
		await store.close();
		await store.close();
		await expect(store.count()).rejects.toMatchObject({ code: 'CLOSED' });
		await expect(
			store.claim({ owner: 'w', now: T0, leaseMs: MINUTE }),
		).rejects.toMatchObject({ code: 'CLOSED' });
	});

	test('a server out of reach is INVALID at the first call, never repeating the password', async () => {
		const client = new MongoClient(
			'mongodb://bumail:secret@127.0.0.1:1/queue',
			{ serverSelectionTimeoutMS: 200 },
		);
		const store = MongoQueueStore.open({ db: fits(client.db()) });
		const first = store.count();
		await expect(first).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringContaining('The MongoDB queue cannot be set up:'),
		});
		await expect(first).rejects.not.toThrow('secret');
		await store.close();
		await client.close();
	});
});

describeMongo('MongoQueueStore on MongoDB', (url) => {
	const { admin, db, create, prefix, prefixFor, share } = temporaryStores(url);

	test('the first call makes the indexes and writes the layout once, however many instances start together', async () => {
		const store = create();
		const others = Array.from({ length: 4 }, () => share(store));
		await Promise.all([store, ...others].map((s) => s.count()));
		const p = prefixFor(store);
		const indexes = await admin.collection(`${p}items`).indexes();
		expect(indexes.map((i) => i.name).sort()).toEqual([
			'_id_',
			'bumail_due',
			'bumail_slot',
		]);
		expect(indexes.find((i) => i.name === 'bumail_slot')).toMatchObject({
			key: { slot: 1 },
			unique: true,
			partialFilterExpression: { slot: { $exists: true } },
		});
		expect(
			await admin
				.collection(`${p}schema`)
				.find({ _id: 'layout' as never })
				.toArray(),
		).toEqual([{ _id: 'layout' as never, version: LAYOUT }]);
	});

	test('the claim reads the due index', async () => {
		const store = create();
		await store.add(entry());
		const plan = await admin
			.collection(`${prefixFor(store)}items`)
			.find({ nextAttemptAt: { $lte: T0 }, expiresAt: { $not: { $gt: T0 } } })
			.sort({ nextAttemptAt: 1, seq: 1 })
			.limit(1)
			.explain();
		const text = JSON.stringify(plan);
		expect(text).toContain('"indexName":"bumail_due"');
		expect(text).not.toContain('"stage":"SORT"');
	});

	test('an item, its message, byte for byte, and its lease outlive the instance', async () => {
		const first = create();
		// Every byte value, and sequences no UTF-8 decoder would give back.
		const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) =>
			i < 256 ? i : (i * 7919) % 256,
		);
		const item = await first.add(entry({ message: bytes }));
		await first.claim({ owner: 'w1', now: T0, leaseMs: MINUTE });
		await first.close();
		const again = share(first);
		expect((await again.get(item.id))?.lease?.owner).toBe('w1');
		const read = await again.readMessage(item.id);
		expect(read?.constructor).toBe(Uint8Array);
		expect(read).toEqual(bytes);
	});

	test('a layout from a newer store is refused', async () => {
		const store = create();
		await store.count();
		await admin
			.collection(`${prefixFor(store)}schema`)
			.updateOne({ _id: 'layout' as never }, { $set: { version: LAYOUT + 1 } });
		const later = share(store);
		await expect(later.count()).rejects.toMatchObject({
			code: 'INVALID',
			message: `The database is at schema version ${LAYOUT + 1}, newer than this store's ${LAYOUT}`,
		});
	});

	test('a layout document that holds no version is refused, before any index is made', async () => {
		for (const version of ['1', 0, 1.5, null, undefined]) {
			const collectionPrefix = prefix();
			await admin
				.collection(`${collectionPrefix}schema`)
				.insertOne({ _id: 'layout' as never, version });
			const store = MongoQueueStore.open({ db: db(), collectionPrefix });
			await expect(store.count()).rejects.toMatchObject({
				code: 'INVALID',
				message: `The collection ${collectionPrefix}schema does not hold a layout version: is the prefix another application's?`,
			});
			expect(
				await admin
					.collection(`${collectionPrefix}items`)
					.indexes()
					.catch(() => []),
			).toEqual([]);
		}
	});

	test('close leaves the client open', async () => {
		const given = db();
		const store = MongoQueueStore.open({
			db: given,
			collectionPrefix: prefix(),
		});
		await store.add(entry());
		await store.close();
		await expect(store.count()).rejects.toMatchObject({ code: 'CLOSED' });
		expect(await given.command({ ping: 1 })).toMatchObject({ ok: 1 });
	});
});
