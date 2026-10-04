import { expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';
import { PostgresQueueStore } from './store';

describePostgres('PostgresQueueStore with a worker role', (url) => {
	const { admin, create, prefix, tablesOf } = temporaryStores(url);

	/**
	 * A role that may log in and use the tables of `tablePrefix`, if given,
	 * with no `CREATE` on any schema (PostgreSQL 15 and later give PUBLIC
	 * none on `public`); dropped once `body` has run.
	 */
	async function asWorker(
		tablePrefix: string | undefined,
		body: (workerUrl: URL) => Promise<void>,
	) {
		const role = `bumail_worker_${crypto.randomUUID().slice(0, 8)}`;
		await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'worker'`);
		try {
			if (tablePrefix) {
				const tables = ['items', 'messages', 'schema'].map(
					(t) => `${tablePrefix}${t}`,
				);
				await admin.unsafe(
					`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(', ')} TO ${role}`,
				);
			}
			const workerUrl = new URL(url);
			workerUrl.username = role;
			workerUrl.password = 'worker';
			await body(workerUrl);
		} finally {
			await admin.unsafe(`DROP OWNED BY ${role}`);
			await admin.unsafe(`DROP ROLE ${role}`);
		}
	}

	test('once an owner migrated, a role with only SELECT, INSERT, UPDATE and DELETE runs the queue', async () => {
		const owner = create();
		await owner.migrate();
		const tablePrefix = tablesOf(owner);
		await asWorker(tablePrefix, async (workerUrl) => {
			const store = PostgresQueueStore.open({ sql: workerUrl, tablePrefix });
			try {
				const item = await store.add(entry(), { maxItems: 10 });
				const claimed = await store.claim({
					owner: 'w1',
					now: T0,
					leaseMs: MINUTE,
				});
				expect(claimed?.id).toBe(item.id);
				expect(await store.renew(item.id, 'w1', T0 + 2 * MINUTE)).toBe(true);
				const done = await store.complete(item.id, 'w1', {
					now: T0,
					recipients: [
						{ address: 'joe@example.com', status: 'delivered' },
						{ address: 'ann@example.org', status: 'delivered' },
					],
					nextAttemptAt: T0,
					attempts: 1,
					delayNotified: false,
				});
				expect(done?.recipients.map((r) => r.status)).toEqual([
					'delivered',
					'delivered',
				]);
				expect(await store.count()).toBe(0);
			} finally {
				await store.close();
			}
		});
	});

	test('the same role cannot make the tables: the first call says so', async () => {
		const tablePrefix = prefix();
		await asWorker(undefined, async (workerUrl) => {
			const store = PostgresQueueStore.open({ sql: workerUrl, tablePrefix });
			try {
				await expect(store.count()).rejects.toThrow(
					'The PostgreSQL queue cannot be set up: permission denied for schema public',
				);
			} finally {
				await store.close();
			}
		});
	});
});
