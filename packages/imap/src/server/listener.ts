import type { Socket, SocketHandler } from 'bun';
import type { Connection } from './connection';
import type { HeaderReader } from './proxy/reader';
import type { ProxiedTls } from './proxy/tls';
import type { RawSocket } from './raw-socket';
import type { Settings } from './settings';
import { SocketTransport } from './transport';

/**
 * What a socket of the IMAP server does: the handlers the clear socket and
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

/**
 * A socket's state, or nothing: Bun may call `error` or `close` before
 * `open` set it — a clear client on the implicit-TLS port fails its
 * handshake first — so every handler reads it through here.
 */
export function stateOf(socket: Socket<SocketState>): SocketState | undefined {
	return socket.data as SocketState | undefined;
}

/** Bytes from the client, in clear or decrypted: they start the idle time again. */
export function received(
	socket: Socket<SocketState>,
	settings: Settings,
	chunk: Uint8Array,
): void {
	const state = socket.data;
	// A hang-up that lingers waits for the client to stop sending.
	state.transport?.received();
	socket.timeout(settings.timeout);
	state.connection?.receive(chunk);
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
			if (state.header) return state.header.receive(chunk);
			if (!state.tls) return received(socket, settings, chunk);
			// TLS records: decrypted, they come back through `received`.
			state.transport?.received();
			state.tls.receive(chunk);
		},
		drain(socket) {
			const state = stateOf(socket);
			if (!state || state.upgraded) return;
			if (state.tls) state.tls.rawDrain();
			else state.transport?.drain();
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
): SocketTransport {
	const transport = new SocketTransport(
		raw,
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
