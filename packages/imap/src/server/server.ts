import type { Socket, SocketHandler, TCPSocketListener } from 'bun';
import { ImapError } from '../errors';
import { Connection } from './connection';
import type { ImapServerOptions } from './options';
import { type Settings, settingsOf } from './settings';
import { SocketTransport } from './transport';

const TOO_MANY = new TextEncoder().encode(
	'* BYE [UNAVAILABLE] Too many connections, try later\r\n',
);

interface SocketState {
	connection?: Connection;
	transport?: SocketTransport;
	/** Bytes on the raw socket after STARTTLS are the TLS stream itself: ignored. */
	upgraded: boolean;
	/**
	 * Implicit TLS whose handshake has not completed: the socket is counted,
	 * but bounded by `handshakeTimeout`, and `start` waits for the handshake.
	 */
	handshaking?: boolean;
	/** What the server does once the handshake completes: greet, or turn away. */
	start?: () => void;
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

/**
 * A socket's state, or nothing: Bun may call `error` or `close` before
 * `open` set it — a clear client on the implicit-TLS port fails its
 * handshake first — so every handler reads it through here.
 */
function stateOf(socket: Socket<SocketState>): SocketState | undefined {
	return socket.data as SocketState | undefined;
}

/**
 * The handlers the clear socket and the TLS one share: input, drain, idle
 * time. Each reads the state through `stateOf`: Bun may report an error or
 * a close on a socket whose `open` never ran.
 */
export function handlers(settings: Settings): SocketHandler<SocketState> {
	return {
		data(socket, chunk) {
			const state = stateOf(socket);
			if (!state || state.upgraded) return;
			// A hang-up that lingers waits for the client to stop sending.
			state.transport?.received();
			socket.timeout(settings.timeout);
			state.connection?.receive(chunk);
		},
		drain(socket) {
			const state = stateOf(socket);
			if (state && !state.upgraded) state.transport?.drain();
		},
		error(socket) {
			void stateOf(socket)?.connection?.close();
		},
		timeout(socket) {
			const state = stateOf(socket);
			if (!state || state.upgraded) return;
			// A TLS handshake that never completed: nothing to say, no one to say it to.
			if (state.handshaking) return socket.terminate();
			void state.connection?.close('Idle for too long, closing', {
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
						stateOf(s)?.transport?.closed();
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
	/** Implicit TLS sockets still in their handshake, for `stop(true)`. */
	const handshaking = new Set<Socket<SocketState>>();
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
					// With a `handshake` handler, Bun calls `open` on implicit TLS
					// as soon as TCP connects; without one, only once the
					// handshake completed, so a client that never sends its
					// ClientHello would be counted by no limit and bounded by no
					// timer.
					open(socket) {
						socket.data = { upgraded: false, handshaking: secure };
						socket.timeout(
							secure ? settings.handshakeTimeout : settings.timeout,
						);
						const begin = (start: () => void) => {
							if (!secure) return start();
							handshaking.add(socket);
							socket.data.start = start;
						};
						const transport = transportOf(socket, settings, secure);
						if (open.size >= settings.maxConnections) {
							// Through the transport: its end is bounded, on TLS too.
							return begin(() => {
								transport.write(TOO_MANY);
								transport.end();
							});
						}
						const connection = new Connection(settings, transport);
						open.add(connection);
						socket.data.connection = connection;
						begin(() => void connection.open());
					},
					handshake(socket, success) {
						const state = stateOf(socket);
						if (!state?.handshaking) return;
						handshaking.delete(socket);
						// A failed handshake: Bun closes the socket, and `close` counts it out.
						if (!success) return;
						state.handshaking = false;
						socket.timeout(settings.timeout);
						const start = state.start;
						delete state.start;
						start?.();
					},
					close(socket) {
						handshaking.delete(socket);
						const state = stateOf(socket);
						const connection = state?.connection;
						if (connection) open.delete(connection);
						state?.transport?.closed();
						void connection?.close();
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
			// every connection here, as a timeout does. A socket still in its
			// handshake has no TLS to say BYE on: it is reset.
			const stuck = new Set<Connection | undefined>();
			for (const socket of [...handshaking]) {
				stuck.add(stateOf(socket)?.connection);
				handshaking.delete(socket);
				socket.terminate();
			}
			for (const connection of [...open]) {
				if (stuck.has(connection)) continue;
				void connection.close(undefined, { forced: true });
			}
		},
	};
}
