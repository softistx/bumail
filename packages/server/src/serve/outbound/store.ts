import type { QueueStore } from '@bumail/queue';
import { PostgresQueueStore } from '@bumail/queue/postgres';
import { RedisQueueStore } from '@bumail/queue/redis';
import { SqliteQueueStore } from '@bumail/queue/sqlite';
import type { QueueConfig } from '../../config/types';
import { ServerError } from '../../errors';
import { maskedFor } from '../../store/open';

/** An outbound queue store the server opened, and closes. */
export interface OpenedQueueStore {
	readonly store: QueueStore;
	close(): Promise<void>;
}

/**
 * Opens the queue store `queue.url` names: `sqlite:<directory>`,
 * `postgres://…` or `redis://…` (`rediss://` too). A server store
 * connects at its first call. What fails is `ServerError('UNAVAILABLE')`,
 * its message never repeating the URL's password.
 */
export function openQueueStore(config: QueueConfig): OpenedQueueStore {
	const { url } = config;
	try {
		if (url.startsWith('sqlite:')) {
			const store = SqliteQueueStore.open({
				directory: decodeURIComponent(new URL(url).pathname),
			});
			return { store, close: async () => store.close() };
		}
		if (url.startsWith('redis:') || url.startsWith('rediss:')) {
			const store = RedisQueueStore.open({ url });
			return { store, close: () => store.close() };
		}
		const store = PostgresQueueStore.open({ sql: url });
		return { store, close: () => store.close() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ServerError(
			'UNAVAILABLE',
			`the queue cannot be opened (${maskedFor(message, url)})`,
		);
	}
}
