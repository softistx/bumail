import { isIP } from 'node:net';
import { jmap } from '@bumail/jmap';
import type { MailStore } from '@bumail/store';
import type { ServerConfig } from '../../config/types';
import { jmapAuthenticate } from '../../directory/adapters';
import type { Directory } from '../../directory/directory';
import { canonical } from '../../proxy/canonical';
import type { Log } from '../log';
import type { TlsFiles } from '../tls';
import { type Client, forwardedClient } from './client';
import { type HttpListener, httpListener } from './listener';
import { trustsOf } from './trusted';

/** What the JMAP listener needs from the server. */
export interface JmapContext {
	readonly config: ServerConfig;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly tls: TlsFiles;
	readonly log: Log;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
}

/** What `listen` says of a bind behind a proxy that has no TCP address. */
export const NO_CLIENT_ADDRESS =
	"behind a proxy, a client's address is known only on a TCP socket: bind to an IP address, not a unix socket";

/** The header the client is carried in, from `fetch` to the middlewares; never read from the network. */
const CLIENT_HEADER = 'x-bumail-client';

/**
 * `request` with `client` set in `CLIENT_HEADER`, whatever the sender
 * put there: alxia hands its middlewares a copy of a request that has a body,
 * so what is known of the request travels in the request itself.
 */
function stamped(request: Request, client: Client): Request {
	const headers = new Headers(request.headers);
	headers.set(
		CLIENT_HEADER,
		`${client.secure ? 'https' : 'http'} ${client.ip}`,
	);
	return new Request(request, { headers });
}

/** The client `stamped` set, or `undefined` for a request that did not come through `fetch`. */
function readClient(headers: Headers): Client | undefined {
	const [scheme, ip] = (headers.get(CLIENT_HEADER) ?? '').split(' ');
	return ip === undefined || ip === ''
		? undefined
		: { ip, secure: scheme === 'https' };
}

/**
 * JMAP (`@bumail/jmap`) over the directory and the store, on `ports.https`:
 *
 * - `jmap.mode = "https"`: TLS from files, the client the TCP peer;
 * - `jmap.mode = "proxy"`: plain HTTP for the proxies of `jmap.trusted`
 *   alone (a peer not listed gets a 403, before anything is read), which
 *   end TLS; the client and whether TLS was used come from
 *   `X-Forwarded-For` and `X-Forwarded-Proto` only when the peer is
 *   trusted (`forwardedClient`).
 *
 * Basic credentials go through the directory, the limiter counting the
 * client's address, so logins behind a proxy do not share one bucket. The
 * session's URLs start with `jmap.origin`, never with the request's own
 * `Host`. A request with no peer address — a unix socket — is refused.
 */
export function createJmap(ctx: JmapContext): HttpListener {
	const { config, log } = ctx;
	const proxied = config.jmap.mode === 'proxy';
	const trusts = trustsOf(config.jmap.trusted);
	const clientOf = (request: Request) => readClient(request.headers);
	const app = jmap({
		store: ctx.store,
		origin: config.jmap.origin,
		secure: (request) => clientOf(request)?.secure === true,
		authenticate: jmapAuthenticate(
			ctx.directory,
			ctx.store,
			(request) => {
				const client = clientOf(request);
				if (client === undefined) throw new Error('a request with no client');
				return client.ip;
			},
			{
				onRefused: (reason, ip) =>
					log(`https: login refused from ${ip}: ${reason}`),
			},
		),
		onError(error, { request }) {
			log(
				`https: error in a request from ${clientOf(request)?.ip ?? 'an unknown client'}: ${ctx.describe(error)}`,
			);
		},
	});
	return httpListener({
		tls: proxied ? undefined : ctx.tls,
		swappable: config.jmap.reloadTls,
		check(hostname) {
			if (proxied && isIP(hostname) === 0) throw new Error(NO_CLIENT_ADDRESS);
		},
		fetch(request, server) {
			const address = server.requestIP(request)?.address;
			const peer = address === undefined ? undefined : canonical(address);
			if (peer === undefined) {
				log('https: a request with no client address was refused');
				return new Response('the client address is unknown', { status: 500 });
			}
			// Behind a proxy, only the proxies are served: a request from
			// anyone else never reaches a header, a login or the app.
			if (proxied && !trusts(peer)) {
				return new Response('forbidden', { status: 403 });
			}
			const client = proxied
				? forwardedClient(peer, request.headers, trusts)
				: { ip: peer, secure: true };
			return app.fetch(stamped(request, client), server);
		},
	});
}
