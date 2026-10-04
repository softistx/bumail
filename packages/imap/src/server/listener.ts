import type { Socket, SocketHandler } from 'bun';
import { Connection } from './connection';
import type { Settings } from './settings';
import { SocketTransport } from './transport';

/**
 * What a socket of the IMAP server does: the handlers the clear socket and
 * the TLS one share, the STARTTLS upgrade, and the listener's own `open`,
 * `handshake` and `close`, which count a socket from its TCP connection.
 */

const TOO_MANY = new TextEncoder().encode(
	'* BYE [UNAVAILABLE] Too many connections, try later\r\n',
);

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
 * A socket's state, or nothing: Bun may call `error` or `close` before
 * `open` set it — a clear client on the implicit-TLS port fails its
 * handshake first — so every handler reads it through here.
 */
export function stateOf(socket: Socket<SocketState>): SocketState | undefined {
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
 * The listener's own handlers: `open` counts a socket and greets it or turns
 * it away, `handshake` lets implicit TLS start once encrypted, `close`
 * frees its place. `handshaking` holds the sockets still in their
 * handshake, for `stop(true)`.
 */
export function listenerHandlers(
	settings: Settings,
	open: Set<Connection>,
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
	};
}
