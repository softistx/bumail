import { expect, test } from 'bun:test';
import { MongoClient } from 'mongodb';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import {
	collectionsOf,
	describeMongo,
	temporaryStores,
} from './servers.fixtures';
import { MongoQueueStore } from './store';

/** What a worker does on each collection once the queue is set up: the guide's role. */
const ACTIONS = ['find', 'insert', 'update', 'remove'];

describeMongo('MongoQueueStore with a user of limited roles', (url) => {
	const { admin, create, prefix, prefixFor } = temporaryStores(url);

	/**
	 * A user of the test database with `roles`, and, given a prefix, a role
	 * of its own with `ACTIONS` on that queue's collections; both dropped
	 * once `body` has run.
	 */
	async function asUser(
		collectionPrefix: string | undefined,
		roles: string[],
		body: (userUrl: URL) => Promise<void>,
	) {
		const name = `bumail_worker_${crypto.randomUUID().slice(0, 8)}`;
		const own = [...roles];
		if (collectionPrefix) {
			await admin.command({
				createRole: name,
				privileges: collectionsOf(collectionPrefix).map((collection) => ({
					resource: { db: admin.databaseName, collection },
					actions: ACTIONS,
				})),
				roles: [],
			});
			own.push(name);
		}
		await admin.command({ createUser: name, pwd: 'worker', roles: own });
		try {
			const userUrl = new URL(url);
			userUrl.username = name;
			userUrl.password = 'worker';
			userUrl.searchParams.set('authSource', admin.databaseName);
			await body(userUrl);
		} finally {
			await admin.command({ dropUser: name });
			if (collectionPrefix) await admin.command({ dropRole: name });
		}
	}

	async function run(
		userUrl: URL,
		collectionPrefix: string,
		body: (store: MongoQueueStore) => Promise<void>,
	) {
		const client = new MongoClient(userUrl.href);
		const store = MongoQueueStore.open({ db: client.db(), collectionPrefix });
		try {
			await body(store);
		} finally {
			await store.close();
			await client.close();
		}
	}

	test('once set up, find, insert, update and remove on its three collections run the queue', async () => {
		const owner = create();
		await owner.count();
		const collectionPrefix = prefixFor(owner);
		await asUser(collectionPrefix, [], (userUrl) =>
			run(userUrl, collectionPrefix, async (store) => {
				const item = await store.add(entry(), { maxItems: 10 });
				expect(await store.readMessage(item.id)).toEqual(entry().message);
				const claimed = await store.claim({
					owner: 'w1',
					now: T0,
					leaseMs: MINUTE,
				});
				expect(claimed?.id).toBe(item.id);
				expect(await store.renew(item.id, 'w1', T0 + 2 * MINUTE)).toBe(true);
				const later = await store.complete(item.id, 'w1', {
					now: T0,
					recipients: [{ address: 'joe@example.com', status: 'delivered' }],
					nextAttemptAt: T0 + MINUTE,
					attempts: 1,
					delayNotified: false,
				});
				expect(later?.attempts).toBe(1);
				expect(await store.reschedule(item.id, T0)).toBe(true);
				expect((await store.list()).map((i) => i.id)).toEqual([item.id]);
				expect((await store.cancel(item.id))?.id).toBe(item.id);
				expect(await store.count()).toBe(0);
			}),
		);
	});

	test('the same user cannot set a new queue up: the first call says so', async () => {
		const collectionPrefix = prefix();
		await asUser(collectionPrefix, [], (userUrl) =>
			run(userUrl, collectionPrefix, async (store) => {
				const first = store.count();
				await expect(first).rejects.toMatchObject({ code: 'INVALID' });
				await expect(first).rejects.toThrow(
					'The MongoDB queue cannot be set up: not authorized on',
				);
				await expect(first).rejects.not.toThrow('worker@');
			}),
		);
	});

	test('readWrite on the database sets a new queue up and runs it', async () => {
		const collectionPrefix = prefix();
		await asUser(undefined, ['readWrite'], (userUrl) =>
			run(userUrl, collectionPrefix, async (store) => {
				const item = await store.add(entry(), { maxItems: 10 });
				expect(
					(await store.claim({ owner: 'w', now: T0, leaseMs: MINUTE }))?.id,
				).toBe(item.id);
			}),
		);
	});
});
