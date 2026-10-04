import type { Socket, TCPSocketListener } from 'bun';
import { SmtpError } from '../errors';
import type { Connection } from './connection';
import { handlers, listenerHandlers, type SocketState } from './listener';
import type { SmtpServerOptions } from './options';
import { settingsOf } from './settings';
import { Slots } from './slots';

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
	return {
		get connections() {
			return slots.size;
		},
		async listen({ port, hostname = '0.0.0.0' }) {
			if (listener) {
				throw new SmtpError(
					'ALREADY_LISTENING',
					`listen(): the server is already listening on ${listener.hostname}:${listener.port}`,
				);
			}
			listener = Bun.listen<SocketState>({
				hostname,
				port,
				...(secure && options.tls
					? { tls: { key: options.tls.key, cert: options.tls.cert } }
					: {}),
				socket: {
					...handlers(settings),
					...listenerHandlers(settings, slots, handshaking, secure),
				},
			});
			return { port: listener.port, hostname: listener.hostname };
		},
		stop(closeConnections = false) {
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
