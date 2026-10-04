import { type Http01Responder, http01Responder } from '@bumail/acme';
import { type HttpListener, httpListener } from '../http/listener';
import type { Log } from '../log';

const PREFIX = '/.well-known/acme-challenge/';

/** The HTTP-01 answers the ACME client sets and removes, and the listener that serves them. */
export interface Challenge {
	/** `obtainCertificate`'s hooks. */
	readonly hooks: {
		set(token: string, keyAuthorization: string): void;
		remove(token: string): void;
	};
	/** The listener for `ports.http`. */
	readonly listener: HttpListener;
	/** The responder, for specs. */
	readonly responder: Http01Responder;
}

const notFound = () =>
	new Response('not found', {
		status: 404,
		headers: { 'content-type': 'text/plain' },
	});

/**
 * The port 80 listener of `tls.mode = "acme"`. It answers a GET or HEAD of
 * `/.well-known/acme-challenge/<token>` with the key authorization of a
 * token being validated (`@bumail/acme`'s `http01Responder`), and logs the
 * first request for each token, once. A GET of `/` is a 301 to
 * `https://<hostname>/`, the hostname from the configuration, never from
 * the request's `Host`; anything else is a 404.
 */
export function createChallenge(options: {
	readonly hostname: string;
	readonly log: Log;
}): Challenge {
	const responder = http01Responder();
	const seen = new Set<string>();
	const location = `https://${options.hostname}/`;
	const listener = httpListener({
		fetch(request) {
			let pathname: string;
			try {
				({ pathname } = new URL(request.url));
			} catch {
				return notFound();
			}
			if (pathname.startsWith(PREFIX)) {
				const answer = responder.fetch(request);
				const token = pathname.slice(PREFIX.length);
				if (answer.status === 200 && !seen.has(token)) {
					seen.add(token);
					options.log(
						`acme: the CA fetched the challenge ${token.slice(0, 8)}...`,
					);
				}
				return answer;
			}
			if (request.method === 'GET' && pathname === '/') {
				return new Response(null, { status: 301, headers: { location } });
			}
			return notFound();
		},
	});
	return {
		hooks: {
			set: (token, keyAuthorization) => {
				responder.set(token, keyAuthorization);
			},
			remove: (token) => {
				responder.remove(token);
				seen.delete(token);
			},
		},
		listener,
		responder,
	};
}
