import type { Checker } from './checker';
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
 * password from Bun's options and `PGPASSWORD`, which Bun sends when the
 * URL holds none. Credentials to this machine may go in clear.
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
		options = new Bun.SQL(value).options as PgOptions;
	} catch {
		// Bun's reason can repeat the URL's parameters: never shown.
		checker.add(path, 'is not a PostgreSQL URL Bun.sql takes');
		return undefined;
	}
	const password =
		(typeof options.password === 'string' && options.password !== '') ||
		url.password !== '' ||
		Boolean(context.env['PGPASSWORD']);
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
	const inClear =
		url.protocol === 'redis:' &&
		url.password !== '' &&
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
