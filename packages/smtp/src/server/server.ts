import type { Socket, SocketHandler, TCPSocketListener } from 'bun';
import { SmtpError } from '../errors';
import { reply } from '../protocol/reply';
import { Connection } from './connection';
import type { SmtpServerOptions } from './options';
import { type Settings, settingsOf } from './settings';
import { SocketTransport } from './transport';

interface SocketState {
	connection?: Connection;
	transport?: SocketTransport;
	/** Bytes on the raw socket after STARTTLS are the TLS stream itself: ignored. */
	upgraded: boolean;
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

/** The handlers both the clear socket and the TLS one share: input, drain, idle time. */
function handlers(settings: Settings): SocketHandler<SocketState> {
	const idle = reply(
		421,
		'4.4.2',
		`${settings.options.hostname} Idle too long, closing`,
	);
	return {
		data(socket, chunk) {
			if (socket.data.upgraded) return;
			// A hang-up that lingers waits for the client to stop sending.
			socket.data.transport?.received();
			// Any byte from the client starts the idle time again.
			socket.timeout(settings.timeout);
			socket.data.connection?.receive(chunk);
		},
		drain(socket) {
			if (!socket.data.upgraded) socket.data.transport?.drain();
		},
		error(socket) {
			socket.data.connection?.close();
		},
		timeout(socket) {
			if (socket.data.upgraded) return;
			const { connection, transport } = socket.data;
			// Closed already, after QUIT, and the 221 still waits for a client
			// that stopped reading: the idle time is up for that too.
			if (connection?.closed) transport?.abort();
			else connection?.close(idle);
		},
	};
}

/** Wraps a socket; STARTTLS swaps it for the encrypted one. */
function transportOf(
	socket: Socket<SocketState>,
	settings: Settings,
	secure: boolean,
): SocketTransport {
	const transport = new SocketTransport(
		socket as Socket<unknown>,
		secure,
		() => {
			const tls = settings.options.tls;
			const connection = socket.data.connection;
			if (!tls || !connection) return;
			socket.data.upgraded = true;
			const [, encrypted] = socket.upgradeTLS<SocketState>({
				tls: { key: tls.key, cert: tls.cert },
				data: { connection, upgraded: false },
				socket: {
					...handlers(settings),
					close: (s) => {
						s.data.transport?.closed();
						connection.close();
					},
				},
			});
			encrypted.timeout(settings.timeout);
			const next = new SocketTransport(
				encrypted as Socket<unknown>,
				true,
				() => {},
				socket.remoteAddress,
			);
			encrypted.data.transport = next;
			connection.useTransport(next);
		},
	);
	socket.data.transport = transport;
	return transport;
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
	const open = new Set<Connection>();
	const secure = options.implicitTls === true;
	return {
		get connections() {
			return open.size;
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
					open(socket) {
						socket.data = { upgraded: false };
						socket.timeout(settings.timeout);
						if (open.size >= settings.maxConnections) {
							// Through a transport, so this hang-up is bounded as every other is.
							const refused = new SocketTransport(
								socket as Socket<unknown>,
								secure,
								() => {},
							);
							socket.data.transport = refused;
							refused.write(
								`421 4.3.2 ${options.hostname} Too many connections, try later\r\n`,
							);
							refused.end();
							return;
						}
						const connection = new Connection(
							settings,
							transportOf(socket, settings, secure),
						);
						open.add(connection);
						socket.data.connection = connection;
						void connection.open();
					},
					close(socket) {
						const connection = socket.data.connection;
						if (connection) open.delete(connection);
						socket.data.transport?.closed();
						socket.data.connection?.close();
					},
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
			// every connection here, as a timeout does.
			for (const connection of [...open]) connection.close();
		},
	};
}
