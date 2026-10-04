import { describeQueueStore } from '../contract/queue-store.fixtures';
import { describeMongo, temporaryStores } from './servers.fixtures';

describeMongo('MongoQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeQueueStore('MongoQueueStore', create, share);
});
