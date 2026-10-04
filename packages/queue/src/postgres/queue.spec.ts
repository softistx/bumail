import { describeInstances } from '../queue/instances.fixtures';
import { describeUnreadableMessage } from '../queue/unreadable.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

describePostgres('PostgresQueueStore', (url) => {
	const { admin, create, share, tablesOf } = temporaryStores(url);
	describeInstances('PostgresQueueStore', create, share);
	// The row deleted by hand.
	describeUnreadableMessage('PostgresQueueStore', create, async (store, id) => {
		await admin.unsafe(
			`DELETE FROM ${tablesOf(store)}messages WHERE item_id = $1`,
			[id],
		);
	});
});

// An application's client whose sessions default to a stricter level: the
// store's writes still run at READ COMMITTED, so none fails with 40001.
for (const level of ['repeatable read', 'serializable']) {
	describePostgres(`PostgresQueueStore, clients at ${level}`, (url) => {
		const { create, share } = temporaryStores(url, {
			default_transaction_isolation: level,
		});
		describeInstances(`PostgresQueueStore at ${level}`, create, share);
	});
}
