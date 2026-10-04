import { describeInstances } from '../queue/instances.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

describePostgres('PostgresQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeInstances('PostgresQueueStore', create, share);
});
