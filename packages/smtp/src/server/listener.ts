import type { Socket, SocketHandler } from 'bun';
import { reply } from '../protocol/reply';
import type { Connection } from './connection';
import type { HeaderReader } from './proxy/reader';
import type { ProxiedTls } from './proxy/tls';
import type { RawSocket } from './raw-socket';
import type { Settings } from './settings';
import type { Slots } from './slots';
import { SocketTransport } from './transport';

/**
 * What a socket of the SMTP server does: the handlers the clear socket and
 * the TLS one share, and the STARTTLS upgrade. The listener's own `open`,
 * `handshake` and `close` are in `admission.ts`.
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
	/** A trusted proxy's PROXY header, still coming: nothing else is read meanwhile. */
	header?: HeaderReader;
	/** Implicit TLS behind a PROXY header, over this raw socket. */
	tls?: ProxiedTls;
}

/** Bytes from the client, in clear or decrypted: they start the idle time again. */
export function received(
	socket: Socket<SocketState>,
	settings: Settings,
	chunk: Uint8Array,
): void {
	// A hang-up that lingers waits for the client to stop sending.
	socket.data.transport?.received();
	// Any byte from the client starts the idle time again.
	socket.timeout(settings.timeout);
	socket.data.connection?.receive(chunk);
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
			const state = socket.data;
			if (!state || state.upgraded) return;
			if (state.header) return state.header.receive(chunk);
			if (!state.tls) return received(socket, settings, chunk);
			// TLS records: decrypted, they come back through `received`.
			state.transport?.received();
			state.tls.receive(chunk);
		},
		drain(socket) {
			const state = socket.data;
			if (!state || state.upgraded) return;
			if (state.tls) state.tls.rawDrain();
			else state.transport?.drain();
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
export function turnAway(
	socket: Socket<SocketState>,
	raw: RawSocket,
	secure: boolean,
	line: string,
): void {
	const refused = new SocketTransport(raw, secure, () => {});
	socket.data.transport = refused;
	refused.write(line);
	refused.end();
}

/**
 * Wraps a socket — Bun's, or `ProxiedTls` over it — for the client at
 * `address`; STARTTLS swaps it for the encrypted one.
 */
export function transportOf(
	socket: Socket<SocketState>,
	raw: RawSocket,
	address: string,
	settings: Settings,
	secure: boolean,
	slots: Slots<Connection>,
): SocketTransport {
	const transport = new SocketTransport(
		raw,
		secure,
		() => {
			const tls = settings.tls?.options;
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
				address,
			);
			encrypted.data.transport = next;
			connection.useTransport(next);
		},
		address,
	);
	socket.data.transport = transport;
	return transport;
}
