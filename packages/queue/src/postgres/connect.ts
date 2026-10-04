import { invalid } from '../errors';
import type { PostgresClient, PostgresQueueStoreOptions } from './options';

/** The tables of one queue, each name its prefix and a fixed suffix. */
export interface Tables {
	readonly prefix: string;
	readonly items: string;
	readonly messages: string;
	readonly schema: string;
}

/** The client a store uses, and whether it opened it (and so closes it). */
export interface Connection {
	readonly client: PostgresClient;
	readonly owned: boolean;
	readonly tables: Tables;
}

const DEFAULT_PREFIX = 'bumail_queue_';

/**
 * Within PostgreSQL's 63 bytes for a name once the longest name derived
 * from it (`messages_item_id_fkey`, 21) follows. Nothing else is allowed:
 * the prefix is written into the statements, never bound.
 */
const PREFIX = /^[a-z_][a-z0-9_]{0,39}$/;

function tablesOf(value: unknown): Tables {
	const prefix = value ?? DEFAULT_PREFIX;
	if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
		throw invalid(
			`tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not ${JSON.stringify(prefix)}`,
		);
	}
	return {
		prefix,
		items: `${prefix}items`,
		messages: `${prefix}messages`,
		schema: `${prefix}schema`,
	};
}

const NEEDS_SQL =
	'A PostgreSQL queue store needs sql: a Bun.SQL client or a postgres:// URL';

/** A `postgres://` or `postgresql://` URL; never echoed, since it may hold a password. */
function urlOf(value: string | URL): string {
	const url = URL.parse(String(value));
	if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
		throw invalid(NEEDS_SQL);
	}
	return url.href;
}

const isClient = (value: unknown): value is PostgresClient =>
	(typeof value === 'object' || typeof value === 'function') &&
	value !== null &&
	typeof (value as PostgresClient).unsafe === 'function' &&
	typeof (value as PostgresClient).begin === 'function' &&
	typeof (value as PostgresClient).close === 'function';

/** A `Bun.SQL` client says which database it speaks: the queue needs PostgreSQL. */
function checkAdapter(client: PostgresClient): void {
	const adapter = (client as { options?: { adapter?: unknown } }).options
		?.adapter;
	if (adapter !== undefined && adapter !== 'postgres') {
		throw invalid(
			`sql is a ${String(adapter)} client; the queue needs a PostgreSQL one`,
		);
	}
}

/** Checks the options and opens a client for a URL; connects to nothing yet. */
export function connect(options: PostgresQueueStoreOptions): Connection {
	const given = (options as PostgresQueueStoreOptions | undefined)?.sql;
	const tables = tablesOf(options?.tablePrefix);
	if (isClient(given)) {
		checkAdapter(given);
		return { client: given, owned: false, tables };
	}
	if (typeof given !== 'string' && !(given instanceof URL)) {
		throw invalid(NEEDS_SQL);
	}
	const client = new Bun.SQL(urlOf(given)) as unknown as PostgresClient;
	return { client, owned: true, tables };
}
