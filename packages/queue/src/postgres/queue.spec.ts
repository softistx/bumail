import { describeInstances } from '../queue/instances.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

describePostgres('PostgresQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeInstances('PostgresQueueStore', create, share);
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
