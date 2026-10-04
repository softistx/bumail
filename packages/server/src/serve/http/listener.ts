import type { TlsFiles } from '../tls';

/** An HTTP listener on `Bun.serve`, started and stopped as the mail servers are. */
export interface HttpListener {
	/** Binds; the reason a bind failed is Bun's. Once only. */
	listen(options: {
		port: number;
		hostname: string;
	}): Promise<{ port: number; hostname: string }>;
	/** Requests under way, on a listener replaced by `setTls` too. */
	readonly pending: number;
	/**
	 * Serves from now on with a renewed pair, only on a listener that has TLS.
	 * `Bun.serve` cannot swap the certificate of a server it runs, so a second
	 * one binds the same port (`reusePort`) with the new pair, and the first
	 * stops accepting and finishes the requests it has. One that cannot bind
	 * leaves the first as it was.
	 */
	setTls?(tls: TlsFiles): Promise<void>;
	/** Stops accepting; without `force`, requests under way finish. Again with `force`, closes the connections. */
	stop(force?: boolean): void;
}

export interface HttpOptions {
	/** TLS from files; without it, plain HTTP. */
	readonly tls?: TlsFiles | undefined;
	/**
	 * With `tls`: whether `setTls` can replace the certificate while it
	 * runs. It binds with `reusePort`, so another process of the same user
	 * can bind the port beside it: `false` (default `true`) binds it alone,
	 * and a new certificate counts at the next start.
	 */
	readonly swappable?: boolean;
	/** Answers a request; `server.requestIP(request)` is the peer. */
	fetch(
		request: Request,
		server: Bun.Server<undefined>,
	): Response | Promise<Response>;
	/** What `listen` checks before it binds: throws to refuse. */
	check?(hostname: string): void;
}

/** A listener that serves `options.fetch` once `listen` binds it. */
export function httpListener(options: HttpOptions): HttpListener {
	let server: Bun.Server<undefined> | undefined;
	/** Servers `setTls` replaced, finishing their requests. */
	let replaced: Bun.Server<undefined>[] = [];
	let stopped = false;
	const bind = (port: number, hostname: string, tls?: TlsFiles) =>
		Bun.serve({
			port,
			hostname,
			// Only a server with TLS is ever replaced: it shares its port.
			...(tls === undefined
				? {}
				: { tls, ...(options.swappable === false ? {} : { reusePort: true }) }),
			fetch: options.fetch,
			error: () => new Response('server error', { status: 500 }),
		});
	return {
		get pending() {
			replaced = replaced.filter((old) => old.pendingRequests > 0);
			return (
				(server?.pendingRequests ?? 0) +
				replaced.reduce((sum, old) => sum + old.pendingRequests, 0)
			);
		},
		async listen({ port, hostname }) {
			if (server !== undefined || stopped) {
				throw new Error('an HTTP listener listens once');
			}
			options.check?.(hostname);
			server = bind(port, hostname, options.tls);
			return {
				port: server.port ?? port,
				hostname: server.hostname ?? hostname,
			};
		},
		...(options.tls === undefined || options.swappable === false
			? {}
			: {
					async setTls(tls: TlsFiles) {
						const old = server;
						if (old === undefined || stopped) {
							throw new Error('the HTTP listener is not listening');
						}
						const { port, hostname } = old;
						if (port === undefined || hostname === undefined) {
							throw new Error('the HTTP listener has no TCP address');
						}
						server = bind(port, hostname, tls);
						replaced.push(old);
						void old.stop();
					},
				}),
		stop(force = false) {
			stopped = true;
			for (const one of [server, ...replaced]) void one?.stop(force);
		},
	};
}
