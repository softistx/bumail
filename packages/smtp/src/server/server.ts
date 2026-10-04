import type { Socket, TCPSocketListener } from 'bun';
import { SmtpError } from '../errors';
import { type Listening, listenerHandlers } from './admission';
import type { Connection } from './connection';
import { handlers, type SocketState } from './listener';
import type { SmtpServerOptions } from './options';
import { settingsOf } from './settings';
import { Slots } from './slots';
import { tlsContext } from './tls-context';

/** A key or certificate `listen` cannot use: `INVALID_OPTION`, the reason as its `cause`. */
const invalidTls = (message: string, cause: unknown) =>
	new SmtpError('INVALID_OPTION', message, { cause });

/** Binds the port, once `listen`'s guard passed. */
async function bind(
	options: SmtpServerOptions,
	listening: Omit<Listening, 'proxied'>,
	port: number,
	hostname: string,
	stopped: () => boolean,
): Promise<TCPSocketListener<SocketState>> {
	// Implicit TLS: the key and certificate are checked first, so one
	// that cannot be used fails here alike, with a proxy or without.
	const context =
		listening.secure && options.tls
			? await tlsContext(options.tls, invalidTls)
			: undefined;
	// `stop()` came while the key was being read: nothing is bound.
	if (stopped()) {
		throw new SmtpError(
			'STOPPED',
			'listen(): stop() was called before the server bound its port',
		);
	}
	// Behind a proxy: a clear listener, TLS after the header.
	const proxied = listening.settings.trusts ? context : undefined;
	return Bun.listen<SocketState>({
		hostname,
		port,
		...(listening.secure && options.tls && !proxied
			? { tls: { key: options.tls.key, cert: options.tls.cert } }
			: {}),
		socket: {
			...handlers(listening.settings),
			...listenerHandlers({
				...listening,
				...(proxied ? { proxied } : {}),
			}),
		},
	});
}

export interface SmtpServer {
	/** Starts listening; resolves once the port is bound. Once only: a second call throws. */
	listen(options: {
		port: number;
		hostname?: string;
	}): Promise<{ port: number; hostname: string }>;
	/** Stops listening; `closeConnections` hangs up on every client too. */
	stop(closeConnections?: boolean): void;
	/** Open connections. */
	readonly connections: number;
}

/**
 * An SMTP server (RFC 5321) on `Bun.listen`: EHLO with PIPELINING, SIZE,
 * 8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS (RFC 3207) or
 * implicit TLS (RFC 8314); AUTH PLAIN and LOGIN over TLS only (RFC 4954);
 * policy through hooks. It never relays without AUTH: a recipient outside
 * `localDomains` is refused to an unauthenticated session, whatever the
 * hooks say.
 */
export function createSmtpServer(options: SmtpServerOptions): SmtpServer {
	const settings = settingsOf(options);
	let listener: TCPSocketListener<SocketState> | undefined;
	const slots = new Slots<Connection>();
	/** Implicit TLS sockets still in their handshake, for `stop(true)`. */
	const handshaking = new Set<Socket<SocketState>>();
	const secure = options.implicitTls === true;
	/** `listen` is reading the TLS material, before it binds. */
	let starting = false;
	/** `stop()` was called while `starting`: `listen` binds nothing. */
	let stopRequested = false;
	return {
		get connections() {
			return slots.size;
		},
		async listen({ port, hostname = '0.0.0.0' }) {
			if (listener || starting) {
				throw new SmtpError(
					'ALREADY_LISTENING',
					listener
						? `listen(): the server is already listening on ${listener.hostname}:${listener.port}`
						: 'listen(): the server is already starting to listen',
				);
			}
			// Set before the first await: a second call meanwhile throws, never binds.
			starting = true;
			stopRequested = false;
			try {
				listener = await bind(
					options,
					{ settings, slots, handshaking, secure },
					port,
					hostname,
					() => stopRequested,
				);
				return { port: listener.port, hostname: listener.hostname };
			} finally {
				starting = false;
			}
		},
		stop(closeConnections = false) {
			if (starting) stopRequested = true;
			listener?.stop(closeConnections);
			listener = undefined;
			if (!closeConnections) return;
			// Bun's `stop(true)` closes the sockets the listener holds, and a
			// socket STARTTLS moved to TLS is no longer one of them: hang up on
			// every connection here, as a timeout does. A socket still in its
			// handshake has no TLS to say 421 on: it is reset.
			const stuck = new Set<Connection | undefined>();
			for (const socket of [...handshaking]) {
				stuck.add(socket.data?.connection);
				handshaking.delete(socket);
				socket.terminate();
			}
			for (const connection of slots.connections()) {
				if (!stuck.has(connection)) connection.close();
			}
		},
	};
}
