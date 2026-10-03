import type { QueueStore } from '../contract/queue-store';
import { describeQueueStore } from '../contract/queue-store.fixtures';
import { temporaryStores } from './directories.fixtures';
import type { SqliteQueueStore } from './store';

const { open, share } = temporaryStores();

describeQueueStore(
	'SqliteQueueStore',
	() => open(),
	(store: QueueStore) => share(store as SqliteQueueStore),
);
