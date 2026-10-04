import { invalid } from '../errors';
import { masked } from '../masked';
import type { RedisQueueClient, RedisQueueStoreOptions } from './options';

/** The keys of one queue, each its prefix and a fixed name. */
export interface Keys {
	readonly prefix: string;
	/** Every item, scored by its next attempt: `list` and `count`. */
	readonly items: string;
	/** The items no lease holds, scored by their next attempt: what a claim takes first. */
	readonly ready: string;
	/** The leased items, scored by when their leases expire. */
	readonly leases: string;
	/** The counter that orders items equally due. */
	readonly seq: string;
	/** The layout version. */
	readonly schema: string;
}

/** The client a store uses, and whether it opened it (and so closes it). */
export interface Connection {
	readonly client: RedisQueueClient;
	readonly owned: boolean;
	readonly keys: Keys;
	/** The URL's password, so an error that repeats it is masked; `''` for a given client. */
	readonly password: string;
}

const DEFAULT_PREFIX = 'bumail:queue:';

/**
 * Nothing Redis reads specially: no `{`, so no Cluster hash tag; no `*`,
 * `?`, `[` or `\`, so a `SCAN MATCH` on the prefix matches its keys only;
 * no space or control character.
 */
const PREFIX = /^[a-z][a-z0-9_:.-]{0,39}$/;

export function keysOf(value: unknown): Keys {
	const prefix = value ?? DEFAULT_PREFIX;
	if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
		throw invalid(
			`keyPrefix must be lowercase letters, digits, '_', ':', '.' and '-', starting with a letter, at most 40 characters, not ${JSON.stringify(prefix)}`,
		);
	}
	return {
		prefix,
		items: `${prefix}items`,
		ready: `${prefix}ready`,
		leases: `${prefix}leases`,
		seq: `${prefix}seq`,
		schema: `${prefix}schema`,
	};
}

const NEEDS =
	'A Redis queue store needs client, a Bun.RedisClient, or url, a redis:// URL';

/** The schemes `Bun.RedisClient` takes. */
const SCHEMES = [
	'redis:',
	'rediss:',
	'valkey:',
	'valkeys:',
	'redis+tls:',
	'redis+unix:',
	'redis+tls+unix:',
];

/** A Redis URL; never echoed, since it may hold a password. */
function urlOf(value: unknown): URL {
	if (typeof value !== 'string' && !(value instanceof URL))
		throw invalid(NEEDS);
	const url = URL.parse(String(value));
	if (url === null || !SCHEMES.includes(url.protocol)) throw invalid(NEEDS);
	return url;
}

/**
 * A client of the store's own for the URL. `Bun.RedisClient` refuses
 * some URLs at once (a database that is not a number): that is
 * `INVALID`, its reason kept and the password, should it be repeated,
 * masked.
 */
function clientFor(url: URL): RedisQueueClient {
	try {
		return new Bun.RedisClient(url.href) as unknown as RedisQueueClient;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw invalid(
			`The URL in url cannot be opened: ${masked(reason, url.password)}`,
		);
	}
}

const isClient = (value: unknown): value is RedisQueueClient =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as RedisQueueClient).send === 'function' &&
	typeof (value as RedisQueueClient).getBuffer === 'function' &&
	typeof (value as RedisQueueClient).close === 'function';

/** Checks the options and opens a client for a URL; connects to nothing yet. */
export function connect(options: RedisQueueStoreOptions): Connection {
	if (typeof options !== 'object' || options === null) throw invalid(NEEDS);
	const keys = keysOf(options.keyPrefix);
	const { client, url } = options;
	if (client !== undefined && url !== undefined) {
		throw invalid('A Redis queue store takes client or url, not both');
	}
	if (client !== undefined) {
		if (!isClient(client)) throw invalid(NEEDS);
		return { client, owned: false, keys, password: '' };
	}
	const parsed = urlOf(url);
	return {
		client: clientFor(parsed),
		owned: true,
		keys,
		password: parsed.password,
	};
}
