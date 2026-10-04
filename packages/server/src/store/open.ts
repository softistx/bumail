import type { MailStore } from '@bumail/store';
import { PostgresMailStore } from '@bumail/store/postgres';
import { SqliteMailStore } from '@bumail/store/sqlite';
import type { StoreConfig } from '../config/types';
import { ServerError } from '../errors';
import { masked } from '../masked';

/** A mail store the server opened, and closes. */
export interface OpenedStore {
	readonly store: MailStore;
	close(): Promise<void>;
}

/** `message` with the password of `url` masked, as `@bumail/store` masks it. */
function maskedFor(message: string, url: string): string {
	try {
		return masked(message, new URL(url).password);
	} catch {
		return message;
	}
}

/** What `openStore` says of a SQLite store another process holds. */
export const STORE_HELD =
	'the mail store is in use by another process, such as the running server';

/** Whether a SQLite store refused to open because another process holds it: the running server. */
export function isHeld(error: unknown): boolean {
	return error instanceof ServerError && error.message === STORE_HELD;
}

/**
 * Opens the mail store `store.url` names: `sqlite:<directory>` or
 * `postgres://…`. A SQLite store is one process's at a time, so while
 * the server runs, the `bumail` command finds it held. What fails is
 * `ServerError('UNAVAILABLE')`, its message never repeating the URL.
 */
export function openStore(config: StoreConfig): OpenedStore {
	const { url } = config;
	try {
		if (url.startsWith('sqlite:')) {
			const store = SqliteMailStore.open({
				directory: decodeURIComponent(new URL(url).pathname),
			});
			return { store, close: async () => store.close() };
		}
		const store = PostgresMailStore.open({ sql: url });
		return { store, close: () => store.close() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already open/.test(message)) {
			throw new ServerError('UNAVAILABLE', STORE_HELD);
		}
		throw new ServerError(
			'UNAVAILABLE',
			`the mail store cannot be opened (${maskedFor(message, url)})`,
		);
	}
}

/** A store call's failure, as `ServerError('UNAVAILABLE')`, its message masked. */
export function storeFailure(error: unknown, config: StoreConfig): ServerError {
	if (error instanceof ServerError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new ServerError(
		'UNAVAILABLE',
		`the mail store failed (${maskedFor(message, config.url)})`,
	);
}
