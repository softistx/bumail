import { isBase64url, shown } from '../encoding';
import { AcmeError } from '../errors';
import { http01Path } from './http01';

const PREFIX = '/.well-known/acme-challenge/';
/** The most tokens one responder holds: an order has 100 names at most. */
export const MAX_RESPONDER_TOKENS = 1000;

/**
 * An HTTP-01 responder (RFC 8555 §8.3): `set` and `remove` are the hooks
 * `obtainCertificate` takes, and `fetch` is a `Bun.serve` handler that
 * answers `GET /.well-known/acme-challenge/<token>` with its key
 * authorization, and 404 to anything else.
 */
export interface Http01Responder {
	/** Serves `keyAuthorization` for `token` until `remove`. */
	set(token: string, keyAuthorization: string): void;
	/** Stops serving `token`; a token not served is no error. */
	remove(token: string): void;
	/** The handler: give it to `Bun.serve({ port: 80, fetch })`, or call it from your own. */
	fetch(request: Request): Response;
	/** How many tokens it serves. */
	readonly size: number;
}

/**
 * A responder for HTTP-01 challenges, serving key authorizations from
 * memory. Only a base64url token, and the key authorization made of it
 * (`<token>.<thumbprint>`), is taken; a request for anything else, or
 * with another method than GET or HEAD, is answered 404.
 */
export function http01Responder(): Http01Responder {
	const answers = new Map<string, string>();
	return {
		set(token: string, keyAuthorization: string): void {
			const path = http01Path(token);
			if (
				typeof keyAuthorization !== 'string' ||
				!keyAuthorization.startsWith(`${token}.`) ||
				!isBase64url(keyAuthorization.slice(token.length + 1))
			) {
				throw new AcmeError(
					'INVALID_OPTION',
					`http01Responder(): the key authorization of a token is "<token>.<thumbprint>", not ${shown(keyAuthorization)}`,
				);
			}
			if (!answers.has(path) && answers.size >= MAX_RESPONDER_TOKENS) {
				throw new AcmeError(
					'INVALID_OPTION',
					`http01Responder(): it already serves ${MAX_RESPONDER_TOKENS} tokens; remove some first`,
				);
			}
			answers.set(path, keyAuthorization);
		},
		remove(token: string): void {
			if (typeof token === 'string') answers.delete(`${PREFIX}${token}`);
		},
		fetch(request: Request): Response {
			let path: string;
			try {
				path = new URL(request.url).pathname;
			} catch {
				return notFound();
			}
			const answer =
				request.method === 'GET' || request.method === 'HEAD'
					? answers.get(path)
					: undefined;
			if (answer === undefined) return notFound();
			return new Response(request.method === 'HEAD' ? null : answer, {
				headers: {
					'content-type': 'application/octet-stream',
					'cache-control': 'no-store',
				},
			});
		},
		get size(): number {
			return answers.size;
		},
	};
}

function notFound(): Response {
	return new Response('Not found', {
		status: 404,
		headers: { 'content-type': 'text/plain' },
	});
}
