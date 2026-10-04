import type { Socket, SocketHandler } from 'bun';
import { reply } from '../protocol/reply';
import { clientKey } from './client-key';
import { Connection } from './connection';
import type { Settings } from './settings';
import type { Slots } from './slots';
import { SocketTransport } from './transport';

/**
 * What a socket of the SMTP server does: the handlers the clear socket and
 * the TLS one share, the STARTTLS upgrade, and the listener's own `open`,
 * `handshake` and `close`, which count a socket from its TCP connection.
 */

export interface SocketState {
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

/**
 * The handlers both the clear socket and the TLS one share: input, drain,
 * idle time. `socket.data` is read with `?.` throughout: Bun may report an
 * error or a close on a socket whose `open` never ran.
 */
export function handlers(settings: Settings): SocketHandler<SocketState> {
	const idle = reply(
		421,
		'4.4.2',
		`${settings.options.hostname} Idle too long, closing`,
	);
	return {
		data(socket, chunk) {
			if (!socket.data || socket.data.upgraded) return;
			// A hang-up that lingers waits for the client to stop sending.
			socket.data.transport?.received();
			// Any byte from the client starts the idle time again.
			socket.timeout(settings.timeout);
			socket.data.connection?.receive(chunk);
		},
		drain(socket) {
			if (socket.data && !socket.data.upgraded) socket.data.transport?.drain();
		},
		error(socket) {
			socket.data?.connection?.close();
		},
		timeout(socket) {
			if (!socket.data || socket.data.upgraded) return;
			// A TLS handshake that never completed: nothing to say, no one to say it to.
			if (socket.data.handshaking) return socket.terminate();
			const { connection, transport } = socket.data;
			// Closed already, after QUIT, and the 221 still waits for a client
			// that stopped reading: the idle time is up for that too.
			if (connection?.closed) transport?.abort();
			else connection?.close(idle);
		},
	};
}

/** Writes one reply and hangs up, through a transport so the hang-up is bounded as every other is. */
function turnAway(
	socket: Socket<SocketState>,
	secure: boolean,
	line: string,
): void {
	const refused = new SocketTransport(
		socket as Socket<unknown>,
		secure,
		() => {},
	);
	socket.data.transport = refused;
	refused.write(line);
	refused.end();
}

/** Wraps a socket; STARTTLS swaps it for the encrypted one. */
function transportOf(
	socket: Socket<SocketState>,
	settings: Settings,
	secure: boolean,
	slots: Slots<Connection>,
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
						slots.release(connection);
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
 * The listener's own handlers: `open` counts a socket and greets it or turns
 * it away, `handshake` lets implicit TLS start once encrypted, `close`
 * frees the slot. `handshaking` holds the sockets still in their
 * handshake, for `stop(true)`.
 */
export function listenerHandlers(
	settings: Settings,
	slots: Slots<Connection>,
	handshaking: Set<Socket<SocketState>>,
	secure: boolean,
): Pick<SocketHandler<SocketState>, 'open' | 'handshake' | 'close'> {
	return {
		// With a `handshake` handler, Bun calls `open` on implicit TLS
		// as soon as TCP connects; without one, only once the
		// handshake completed, so a client that never sends its
		// ClientHello would be counted by no limit and bounded by no
		// timer.
		open(socket) {
			socket.data = { upgraded: false, handshaking: secure };
			socket.timeout(secure ? settings.handshakeTimeout : settings.timeout);
			const begin = (start: () => void) => {
				if (!secure) return start();
				handshaking.add(socket);
				socket.data.start = start;
			};
			if (slots.size >= settings.maxConnections) {
				return begin(() =>
					turnAway(
						socket,
						secure,
						`421 4.3.2 ${settings.options.hostname} Too many connections, try later\r\n`,
					),
				);
			}
			const key = clientKey(socket.remoteAddress);
			if (slots.of(key) >= settings.maxConnectionsPerClient) {
				return begin(() =>
					turnAway(
						socket,
						secure,
						`421 4.7.0 ${settings.options.hostname} Too many connections from your address, try later\r\n`,
					),
				);
			}
			const connection = new Connection(
				settings,
				transportOf(socket, settings, secure, slots),
			);
			slots.take(connection, key);
			socket.data.connection = connection;
			begin(() => void connection.open());
		},
		handshake(socket, success) {
			const state = socket.data;
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
			const connection = socket.data?.connection;
			if (connection) slots.release(connection);
			socket.data?.transport?.closed();
			connection?.close();
		},
	};
}
