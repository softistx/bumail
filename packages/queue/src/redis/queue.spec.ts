import { describeInstances } from '../queue/instances.fixtures';
import { describeRedis, temporaryStores } from './servers.fixtures';

describeRedis('RedisQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeInstances('RedisQueueStore', create, share);
});
