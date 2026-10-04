import { checkMaxTombstones } from '../contract/checks';
import { StoreError } from '../errors';
import { masked } from '../masked';
import type { PostgresClient, PostgresMailStoreOptions } from './options';

/** The tables of one store, each name its prefix and a fixed suffix. */
export interface Tables {
	readonly prefix: string;
	readonly schema: string;
	readonly counters: string;
	readonly accounts: string;
	readonly mailboxes: string;
	readonly contents: string;
	readonly messages: string;
	readonly memberships: string;
	readonly tombstones: string;
}

/** The client a store uses, whether it opened it (and so closes it), and its tables. */
export interface Connection {
	readonly client: PostgresClient;
	readonly owned: boolean;
	/** The password of the URL the store opened, masked in what it repeats of the client's reasons; `''` otherwise. */
	readonly password: string;
	readonly tables: Tables;
	readonly maxTombstones: number;
}

const DEFAULT_PREFIX = 'bumail_store_';

/**
 * Within PostgreSQL's 63 bytes for a name once the longest name derived
 * from it (`memberships_message`, `tombstones_mailbox`: every index and
 * constraint is named, none longer than 23) follows. Nothing else is
 * allowed: the prefix is written into the statements, never bound.
 */
const PREFIX = /^[a-z_][a-z0-9_]{0,39}$/;

export function tablesOf(prefix: string): Tables {
	return {
		prefix,
		schema: `${prefix}schema`,
		counters: `${prefix}counters`,
		accounts: `${prefix}accounts`,
		mailboxes: `${prefix}mailboxes`,
		contents: `${prefix}contents`,
		messages: `${prefix}messages`,
		memberships: `${prefix}memberships`,
		tombstones: `${prefix}tombstones`,
	};
}

function checkPrefix(value: unknown): string {
	const prefix = value ?? DEFAULT_PREFIX;
	if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
		throw invalid(
			`tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not ${JSON.stringify(prefix)}`,
		);
	}
	return prefix;
}

const invalid = (message: string) => new StoreError('INVALID', message);

const NEEDS_SQL =
	'A PostgreSQL mail store needs sql: a Bun.SQL client or a postgres:// URL';

/** A `postgres://` or `postgresql://` URL; never echoed, since it may hold a password. */
function urlOf(value: string | URL): URL {
	const url = URL.parse(String(value));
	if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
		throw invalid(NEEDS_SQL);
	}
	return url;
}

/**
 * A client of the store's own for the URL. `Bun.SQL` refuses some
 * parameters at once (a `sslmode` it does not know): that is `INVALID`,
 * its reason kept and the password, should it be repeated, masked.
 */
function clientFor(url: URL): PostgresClient {
	try {
		return new Bun.SQL(url.href);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw invalid(
			`The URL in sql cannot be opened: ${masked(reason, url.password)}`,
		);
	}
}

const isClient = (value: unknown): value is PostgresClient =>
	(typeof value === 'object' || typeof value === 'function') &&
	value !== null &&
	typeof (value as PostgresClient).unsafe === 'function' &&
	typeof (value as PostgresClient).begin === 'function' &&
	typeof (value as PostgresClient).close === 'function';

/** A `Bun.SQL` client says which database it speaks: the store needs PostgreSQL. */
function checkAdapter(client: PostgresClient): void {
	const adapter = (client as { options?: { adapter?: unknown } }).options
		?.adapter;
	if (adapter !== undefined && adapter !== 'postgres') {
		throw invalid(
			`sql is a ${String(adapter)} client; the mail store needs a PostgreSQL one`,
		);
	}
}

/** Checks the options and opens a client for a URL; connects to nothing yet. */
export function connect(options: PostgresMailStoreOptions): Connection {
	const given = (options as PostgresMailStoreOptions | undefined)?.sql;
	const tables = tablesOf(checkPrefix(options?.tablePrefix));
	const maxTombstones = checkMaxTombstones(options?.maxTombstones);
	if (isClient(given)) {
		checkAdapter(given);
		return { client: given, owned: false, password: '', tables, maxTombstones };
	}
	if (typeof given !== 'string' && !(given instanceof URL)) {
		throw invalid(NEEDS_SQL);
	}
	const url = urlOf(given);
	return {
		client: clientFor(url),
		owned: true,
		password: url.password,
		tables,
		maxTombstones,
	};
}
