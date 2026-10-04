import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { QueueStore } from '../contract/queue-store';
import { describeQueueStore } from '../contract/queue-store.fixtures';
import { describeUnreadableMessage } from '../queue/unreadable.fixtures';
import { temporaryStores } from './directories.fixtures';
import type { SqliteQueueStore } from './store';

const { directory, open, share } = temporaryStores();

describeQueueStore(
	'SqliteQueueStore',
	() => open(),
	(store: QueueStore) => share(store as SqliteQueueStore),
);

const directoryOf = new WeakMap<QueueStore, string>();

describeUnreadableMessage(
	'SqliteQueueStore',
	() => {
		const at = directory();
		const store = open(at);
		directoryOf.set(store, at);
		return store;
	},
	// The row deleted through another connection, as by hand.
	async (store, id) => {
		const db = new Database(
			join(directoryOf.get(store) as string, 'queue.sqlite'),
		);
		db.run('DELETE FROM messages WHERE item_id = ?', [id]);
		db.close();
	},
);
