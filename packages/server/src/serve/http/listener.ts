import type { TlsFiles } from '../tls';

/** An HTTP listener on `Bun.serve`, started and stopped as the mail servers are. */
export interface HttpListener {
	/** Binds; the reason a bind failed is Bun's. Once only. */
	listen(options: {
		port: number;
		hostname: string;
	}): Promise<{ port: number; hostname: string }>;
	/** Requests under way. */
	readonly pending: number;
	/** Stops accepting; without `force`, requests under way finish. Again with `force`, closes the connections. */
	stop(force?: boolean): void;
}

export interface HttpOptions {
	/** TLS from files; without it, plain HTTP. */
	readonly tls?: TlsFiles | undefined;
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
	let stopped = false;
	return {
		get pending() {
			return server?.pendingRequests ?? 0;
		},
		async listen({ port, hostname }) {
			if (server !== undefined || stopped) {
				throw new Error('an HTTP listener listens once');
			}
			options.check?.(hostname);
			server = Bun.serve({
				port,
				hostname,
				...(options.tls === undefined ? {} : { tls: options.tls }),
				fetch: options.fetch,
				error: () => new Response('server error', { status: 500 }),
			});
			return {
				port: server.port ?? port,
				hostname: server.hostname ?? hostname,
			};
		},
		stop(force = false) {
			stopped = true;
			void server?.stop(force);
		},
	};
}
