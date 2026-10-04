import type { Checker } from './checker';
import { isLoopback } from './names';

/** PostgreSQL's `sslmode` values that encrypt the connection. */
const PG_TLS = new Set(['require', 'verify-ca', 'verify-full']);

/** `sqlite:, postgres: or postgresql:`. */
function schemesOf(schemes: readonly string[]): string {
	const listed = schemes.map((scheme) => `${scheme}:`);
	const last = listed.pop() ?? '';
	return listed.length === 0 ? last : `${listed.join(', ')} or ${last}`;
}

/**
 * `value` as a URL, or `undefined` with a problem recorded. A value whose
 * scheme is not followed by a `/` — `user:secret@host` — is not taken as
 * a URL at all, so its first word is never repeated as a scheme; only
 * `sqlite:`, whose path is checked apart, is taken without one.
 */
function parse(checker: Checker, value: string, path: string): URL | undefined {
	let url: URL | undefined;
	try {
		url = new URL(value);
	} catch {
		url = undefined;
	}
	if (
		url === undefined ||
		(url.protocol !== 'sqlite:' &&
			!value.toLowerCase().startsWith(`${url.protocol}/`))
	) {
		checker.add(path, 'is not a URL');
		return undefined;
	}
	return url;
}

/**
 * Checks a store's URL — `sqlite:<path>`, `postgres://…`, `redis://…` —
 * and answers it, or records a problem and answers `undefined`. A problem
 * names the scheme at most: never the URL, which can hold a password.
 *
 * Credentials sent to a host other than this machine need TLS: `rediss:`
 * for Redis, `sslmode=require` (or `verify-ca`, `verify-full`) for
 * PostgreSQL.
 */
export function checkStoreUrl(
	checker: Checker,
	value: string,
	path: string,
	schemes: readonly string[],
): string | undefined {
	const url = parse(checker, value, path);
	if (url === undefined) return undefined;
	const scheme = url.protocol.slice(0, -1);
	if (!schemes.includes(scheme)) {
		checker.add(
			path,
			`the scheme "${scheme}:" is not one of ${schemesOf(schemes)}`,
		);
		return undefined;
	}
	if (scheme === 'sqlite') {
		if (url.host !== '' || !url.pathname.startsWith('/') || url.search !== '') {
			checker.add(
				path,
				'must be sqlite: and an absolute path, such as sqlite:/data/mail',
			);
			return undefined;
		}
		return value;
	}
	const credentials = url.username !== '' || url.password !== '';
	if (credentials && !isLoopback(url.hostname || 'localhost')) {
		if (scheme === 'redis') {
			checker.add(path, 'sends credentials without TLS; use rediss:');
			return undefined;
		}
		const sslmode = url.searchParams.get('sslmode');
		if (scheme !== 'rediss' && (sslmode === null || !PG_TLS.has(sslmode))) {
			checker.add(
				path,
				'sends credentials without TLS; add sslmode=require (or verify-ca, verify-full)',
			);
			return undefined;
		}
	}
	return value;
}

/**
 * Checks an `https:` URL, such as an ACME directory, or, with `origin`,
 * an origin: no path, query or credentials. Names the scheme at most.
 */
export function checkHttpsUrl(
	checker: Checker,
	value: string,
	path: string,
	origin: boolean,
): string | undefined {
	const url = parse(checker, value, path);
	if (url === undefined) return undefined;
	if (url.protocol !== 'https:') {
		checker.add(path, `the scheme "${url.protocol}" is not https:`);
		return undefined;
	}
	if (url.username !== '' || url.password !== '') {
		checker.add(path, 'must not hold credentials');
		return undefined;
	}
	if (
		origin &&
		(url.pathname !== '/' || url.search !== '' || url.hash !== '')
	) {
		checker.add(
			path,
			'must be an origin, with no path or query, such as https://mail.example.com',
		);
		return undefined;
	}
	return origin ? url.origin : value;
}
