import { describeInstances } from '../queue/instances.fixtures';
import { describeUnreadableMessage } from '../queue/unreadable.fixtures';
import { describeRedis, temporaryStores } from './servers.fixtures';

describeRedis('RedisQueueStore', (url) => {
	const { admin, create, share, prefixFor } = temporaryStores(url);
	describeInstances('RedisQueueStore', create, share);
	// The key evicted or deleted.
	describeUnreadableMessage('RedisQueueStore', create, async (store, id) => {
		await admin.send('DEL', [`${prefixFor(store)}message:${id}`]);
	});
});
