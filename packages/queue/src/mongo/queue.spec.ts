import { describeInstances } from '../queue/instances.fixtures';
import { describeMongo, temporaryStores } from './servers.fixtures';

describeMongo('MongoQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeInstances('MongoQueueStore', create, share);
});
