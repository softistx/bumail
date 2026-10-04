import { describeQueueStore } from '../contract/queue-store.fixtures';
import { describeRedis, temporaryStores } from './servers.fixtures';

describeRedis('RedisQueueStore', (url) => {
	const { create, share } = temporaryStores(url);
	describeQueueStore('RedisQueueStore', create, share);
});
