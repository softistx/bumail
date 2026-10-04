import { describeQueueStore } from '../contract/queue-store.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

describePostgres('PostgresQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeQueueStore('PostgresQueueStore', create, share);
});
