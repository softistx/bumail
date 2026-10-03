import type { Socket, SocketHandler, TCPSocketListener } from 'bun';
import { ImapError } from '../errors';
import { Connection } from './connection';
import type { ImapServerOptions } from './options';
import { type Settings, settingsOf } from './settings';
import { SocketTransport } from './transport';

interface SocketState {
	connection?: Connection;
	transport?: SocketTransport;
	/** Bytes on the raw socket after STARTTLS are the TLS stream itself: ignored. */
	upgraded: boolean;
}

export interface ImapServer {
	/** Starts listening; resolves once the port is bound. Once only: a second call throws. */
	listen(options: {
		port: number;
		hostname?: string;
	}): Promise<{ port: number; hostname: string }>;
	/** Stops listening; `closeConnections` hangs up on every client too. */
	stop(closeConnections?: boolean): void;
	/**
	 * Tells the sessions of an account that its mail changed — after a
	 * delivery, say — so those in IDLE look at the store now rather than at
	 * their next `idleInterval`.
	 */
	notify(accountId: string): void;
	/** Open connections. */
	readonly connections: number;
}

/** The handlers the clear socket and the TLS one share: input, drain, idle time. */
function handlers(settings: Settings): SocketHandler<SocketState> {
	return {
		data(socket, chunk) {
			if (socket.data.upgraded) return;
			socket.timeout(settings.timeout);
			socket.data.connection?.receive(chunk);
		},
		drain(socket) {
			if (!socket.data.upgraded) socket.data.transport?.drain();
		},
		error(socket) {
			void socket.data.connection?.close();
		},
		timeout(socket) {
			if (socket.data.upgraded) return;
			void socket.data.connection?.close('Idle for too long, closing', {
				forced: true,
			});
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
			const { tls } = settings.options;
			const connection = socket.data.connection;
			if (!connection) return;
			socket.data.upgraded = true;
			const [, encrypted] = socket.upgradeTLS<SocketState>({
				tls: { key: tls.key, cert: tls.cert },
				data: { connection, upgraded: false },
				socket: {
					...handlers(settings),
					close: (s) => {
						s.data.transport?.closed();
						void connection.close();
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
 * An IMAP4rev2 server (RFC 9051) on `Bun.listen`, serving the mail of a
 * `MailStore`: STARTTLS (or implicit TLS on 993), LOGIN and AUTHENTICATE
 * PLAIN only once encrypted, then the mailboxes and messages of the
 * account `authenticate` names. IMAP4rev1 clients are served too.
 */
export function createImapServer(options: ImapServerOptions): ImapServer {
	const settings = settingsOf(options);
	let listener: TCPSocketListener<SocketState> | undefined;
	const open = new Set<Connection>();
	const secure = options.implicitTls === true;
	return {
		get connections() {
			return open.size;
		},
		notify(accountId) {
			for (const connection of open) {
				if (connection.state.accountId === accountId) connection.wake?.();
			}
		},
		async listen({ port, hostname = '0.0.0.0' }) {
			if (listener) {
				throw new ImapError(
					'ALREADY_LISTENING',
					`listen(): the server is already listening on ${listener.hostname}:${listener.port}`,
				);
			}
			listener = Bun.listen<SocketState>({
				hostname,
				port,
				...(secure
					? { tls: { key: options.tls.key, cert: options.tls.cert } }
					: {}),
				socket: {
					...handlers(settings),
					open(socket) {
						socket.data = { upgraded: false };
						socket.timeout(settings.timeout);
						if (open.size >= settings.maxConnections) {
							socket.end(
								'* BYE [UNAVAILABLE] Too many connections, try later\r\n',
							);
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
						const { connection } = socket.data;
						if (connection) open.delete(connection);
						socket.data.transport?.closed();
						void connection?.close();
					},
				},
			});
			return { port: listener.port, hostname: listener.hostname };
		},
		stop(closeConnections = false) {
			listener?.stop(closeConnections);
			listener = undefined;
		},
	};
}
