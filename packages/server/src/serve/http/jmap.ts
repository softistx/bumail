import { isIP } from 'node:net';
import { alxia, trustProxy } from '@alxia/core';
import { jmap } from '@bumail/jmap';
import type { MailStore } from '@bumail/store';
import type { ServerConfig } from '../../config/types';
import { jmapAuthenticate } from '../../directory/adapters';
import type { Directory } from '../../directory/directory';
import { canonical } from '../../proxy/canonical';
import type { Log } from '../log';
import type { TlsFiles } from '../tls';
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

/**
 * JMAP (`@bumail/jmap`) over the directory and the store, on `ports.https`:
 *
 * - `jmap.mode = "https"`: TLS from files, the client the TCP peer;
 * - `jmap.mode = "proxy"`: plain HTTP for the proxies of `jmap.trusted`
 *   alone, which end TLS: alxia's `trustProxy` with `untrusted:
 *   'refuse-all'` answers any other peer 403, headers or not, before
 *   routing and every middleware. The client (`ctx.ip`) and whether TLS
 *   was used (`originalUrl(ctx)`) come from what the outermost trusted
 *   proxy wrote in `X-Forwarded-For` and `X-Forwarded-Proto`, and reach
 *   jmap's `authenticate`, `secure` and `onError` as their `client`.
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
	const app = jmap({
		store: ctx.store,
		origin: config.jmap.origin,
		secure: (_request, client) => client.url.protocol === 'https:',
		authenticate: jmapAuthenticate(
			ctx.directory,
			ctx.store,
			(_request, client) => {
				// `fetch` refuses a request with no peer address first.
				if (client?.ip === undefined)
					throw new Error('a request with no client');
				return client.ip;
			},
			{
				onRefused: (reason, ip) =>
					log(`https: login refused from ${ip}: ${reason}`),
			},
		),
		onError(error, { client }) {
			log(
				`https: error in a request from ${client.ip ?? 'an unknown client'}: ${ctx.describe(error)}`,
			);
		},
	});
	// Behind a proxy, only the proxies are served: a request from anyone
	// else never reaches a header, a login or the app.
	const host = proxied
		? alxia({
				proxy: trustProxy({ trusted: trusts, untrusted: 'refuse-all' }),
			}).plugin(app)
		: app;
	return httpListener({
		tls: proxied ? undefined : ctx.tls,
		swappable: config.jmap.reloadTls,
		check(hostname) {
			if (proxied && isIP(hostname) === 0) throw new Error(NO_CLIENT_ADDRESS);
		},
		fetch(request, server) {
			const address = server.requestIP(request)?.address;
			if (address === undefined || canonical(address) === undefined) {
				log('https: a request with no client address was refused');
				return new Response('the client address is unknown', { status: 500 });
			}
			return host.fetch(request, server);
		},
	});
}
