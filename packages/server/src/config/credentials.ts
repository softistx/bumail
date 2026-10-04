import type { Checker } from './checker';
import type { Env } from './env';
import { isLoopback } from './names';
import type { StoreUrlContext } from './urls';

/** Bun.sql's `sslMode` from `require` up (`verify-ca`, `verify-full`): what encrypts. */
const PG_REQUIRE = 2;

/** What `new Bun.SQL(url).options` holds that matters here; it connects to nothing. */
interface PgOptions {
	readonly hostname?: unknown;
	readonly password?: unknown;
	readonly sslMode?: unknown;
}

const REDIS_ONLY =
	'is only for a redis: URL that sends credentials to another host';

/** Refuses `insecure = true` where it means nothing: a URL it does not apply to. */
export function refuseInsecure(
	checker: Checker,
	context: StoreUrlContext,
): void {
	if (context.insecure === true) checker.add(context.insecurePath, REDIS_ONLY);
}

/**
 * Whether a PostgreSQL or Redis URL sends credentials in clear with its
 * operator's consent (`true`), sends none in clear (`false`), or would
 * send them in clear without it (`undefined`, a problem recorded).
 *
 * TLS is decided from what Bun will do, never from one parameter:
 * PostgreSQL's from `new Bun.SQL(url).options.sslMode`, which weighs
 * `sslmode`, `ssl`, `tls` and `PGSSLMODE` as the connection will, and its
 * password and host from the same options, `PGPASSWORD` and `PGHOST`
 * included, all read from the given environment (`pgOptions`). A Redis
 * URL's credentials are its userinfo, a user alone included; Bun's Redis
 * client reads no password from the environment or the query, and
 * `REDIS_URL` only when it is given no URL, which the server never does.
 * Credentials to this machine may go in clear.
 */
export function checkCredentials(
	checker: Checker,
	value: string,
	url: URL,
	path: string,
	context: StoreUrlContext,
): boolean | undefined {
	return url.protocol.startsWith('redis')
		? redis(checker, url, path, context)
		: postgres(checker, value, url, path, context);
}

/** The environment variables Bun's PostgreSQL client reads. */
const PG_ENV =
	/^(?:PG|POSTGRES_|DATABASE_URL$|TLS_DATABASE_URL$|TLS_POSTGRES_DATABASE_URL$)/;

/**
 * `new Bun.SQL(value).options`, as Bun would build them in an environment
 * that is `env`. Bun reads `PGSSLMODE`, `PGHOST`, `PGPASSWORD` and the
 * rest from `process.env` when it is constructed, so those keys of
 * `process.env` are swapped for `env`'s around the constructor, which
 * connects to nothing, and put back at once. When `env` is `process.env`,
 * as when the server runs, nothing changes: the decision is the one the
 * server's own client makes.
 */
function pgOptions(value: string, env: Env): PgOptions {
	if (env === process.env) return new Bun.SQL(value).options as PgOptions;
	const keys = new Set(
		[...Object.keys(process.env), ...Object.keys(env)].filter((key) =>
			PG_ENV.test(key),
		),
	);
	const saved = new Map([...keys].map((key) => [key, process.env[key]]));
	try {
		for (const key of keys) {
			const injected = env[key];
			if (injected === undefined) delete process.env[key];
			else process.env[key] = injected;
		}
		return new Bun.SQL(value).options as PgOptions;
	} finally {
		for (const [key, was] of saved) {
			if (was === undefined) delete process.env[key];
			else process.env[key] = was;
		}
	}
}

function postgres(
	checker: Checker,
	value: string,
	url: URL,
	path: string,
	context: StoreUrlContext,
): boolean | undefined {
	if (context.insecure === true) {
		checker.add(
			context.insecurePath,
			'is only for a redis: URL; for PostgreSQL, write sslmode=disable in the URL',
		);
	}
	let options: PgOptions;
	try {
		options = pgOptions(value, context.env);
	} catch {
		// Bun's reason can repeat the URL's parameters: never shown.
		checker.add(path, 'is not a PostgreSQL URL Bun.sql takes');
		return undefined;
	}
	const password =
		(typeof options.password === 'string' && options.password !== '') ||
		url.password !== '';
	const host =
		typeof options.hostname === 'string' && options.hostname !== ''
			? options.hostname
			: url.hostname || 'localhost';
	const tls =
		typeof options.sslMode === 'number' && options.sslMode >= PG_REQUIRE;
	if (!password || tls || isLoopback(host)) return false;
	const sslmodes = url.searchParams.getAll('sslmode');
	if (sslmodes.length === 1 && sslmodes[0] === 'disable') return true;
	checker.add(
		path,
		'sends credentials without TLS; add sslmode=require (or verify-ca, verify-full), or sslmode=disable to send them in clear',
	);
	return undefined;
}

function redis(
	checker: Checker,
	url: URL,
	path: string,
	context: StoreUrlContext,
): boolean | undefined {
	if (url.searchParams.has('password') || url.searchParams.has('username')) {
		checker.add(
			path,
			'takes its credentials before the host (redis://:password@host); Bun ignores ?password=',
		);
		return undefined;
	}
	// A lone `user@` is a password to Bun too: it sends `AUTH user ""`.
	const inClear =
		url.protocol === 'redis:' &&
		(url.username !== '' || url.password !== '') &&
		!isLoopback(url.hostname || 'localhost');
	if (!inClear) {
		refuseInsecure(checker, context);
		return false;
	}
	if (context.insecure === true) return true;
	checker.add(
		path,
		'sends credentials without TLS; use rediss:, or set insecure = true to send them in clear',
	);
	return undefined;
}
