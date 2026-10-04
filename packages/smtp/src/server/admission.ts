import type { Socket, SocketHandler } from 'bun';
import { clientKey } from './client-key';
import { Connection } from './connection';
import { received, type SocketState, transportOf, turnAway } from './listener';
import { HeaderReader } from './proxy/reader';
import { ProxiedTls } from './proxy/tls';
import type { RawSocket } from './raw-socket';
import type { Settings } from './settings';
import type { Slots } from './slots';
import type { TlsHolder } from './tls-context';

/**
 * The listener's own handlers: `open` counts a socket and greets it or
 * turns it away, `handshake` lets implicit TLS start once encrypted,
 * `close` frees the slot.
 *
 * Behind a trusted proxy (`proxyProtocol`), `open` only starts reading the
 * header: the socket is counted, by the client's address, once the header
 * named it. On implicit TLS with `proxyProtocol`, the listener is a clear
 * one and `proxied` is the TLS context: every socket's TLS runs through
 * `ProxiedTls`, after the header from a trusted proxy, from the first byte
 * from anyone else.
 */
export interface Listening {
	readonly settings: Settings;
	readonly slots: Slots<Connection>;
	/** Sockets still in their handshake or awaiting a PROXY header, for `stop(true)`. */
	readonly handshaking: Set<Socket<SocketState>>;
	/** TLS from the first byte: implicit TLS. */
	readonly secure: boolean;
	readonly proxied?: TlsHolder;
}

export function listenerHandlers(
	listening: Listening,
): Pick<SocketHandler<SocketState>, 'open' | 'handshake' | 'close'> {
	const { settings, slots, handshaking, secure } = listening;
	return {
		// With a `handshake` handler, Bun calls `open` on implicit TLS
		// as soon as TCP connects; without one, only once the
		// handshake completed, so a client that never sends its
		// ClientHello would be counted by no limit and bounded by no
		// timer.
		open(socket) {
			socket.data = { upgraded: false, handshaking: secure };
			socket.timeout(secure ? settings.handshakeTimeout : settings.timeout);
			const peer = socket.remoteAddress;
			if (settings.trusts?.(peer)) awaitHeader(listening, socket, peer);
			else admit(listening, socket, peer);
		},
		handshake: (socket, success) => handshake(listening, socket, success),
		close(socket) {
			handshaking.delete(socket);
			socket.data?.header?.cancel();
			socket.data?.tls?.closed();
			const connection = socket.data?.connection;
			if (connection) slots.release(connection);
			socket.data?.transport?.closed();
			connection?.close();
		},
	};
}

function handshake(
	{ settings, handshaking }: Listening,
	socket: Socket<SocketState>,
	success: boolean,
): void {
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
}

/**
 * A trusted proxy's socket: its header first, within `handshakeTimeout`
 * however slowly it comes, or the socket is reset — nothing written,
 * nothing reported, nothing counted. The proxy's own address is never a
 * client's: no limit counts the socket before the header named one.
 */
function awaitHeader(
	listening: Listening,
	socket: Socket<SocketState>,
	peer: string,
): void {
	const { settings, handshaking, secure } = listening;
	socket.data.handshaking = true;
	socket.timeout(settings.handshakeTimeout);
	handshaking.add(socket);
	socket.data.header = new HeaderReader(
		settings.handshakeTimeout,
		(source, rest) => {
			delete socket.data.header;
			handshaking.delete(socket);
			socket.data.handshaking = secure;
			if (!secure) socket.timeout(settings.timeout);
			admit(listening, socket, source ?? peer, rest);
		},
		() => socket.terminate(),
	);
}

/** Counts the socket as the client at `address`, then greets it or turns it away. */
function admit(
	listening: Listening,
	socket: Socket<SocketState>,
	address: string,
	first?: Uint8Array,
): void {
	const { settings, slots, handshaking, secure, proxied } = listening;
	let raw: RawSocket = socket;
	if (proxied) {
		raw = startTls(listening, socket, proxied);
		if (first && first.length > 0) socket.data.tls?.receive(first);
	}
	const begin = (start: () => void) => {
		if (!secure) return start();
		handshaking.add(socket);
		socket.data.start = start;
	};
	const { hostname } = settings.options;
	const refuse = (line: string) =>
		begin(() => turnAway(socket, raw, secure, `${line}\r\n`));
	if (slots.size >= settings.maxConnections) {
		refuse(`421 4.3.2 ${hostname} Too many connections, try later`);
		return;
	}
	const key = clientKey(address);
	if (slots.of(key) >= settings.maxConnectionsPerClient) {
		refuse(
			`421 4.7.0 ${hostname} Too many connections from your address, try later`,
		);
		return;
	}
	const transport = transportOf(socket, raw, address, settings, secure, slots);
	const connection = new Connection(settings, transport);
	slots.take(connection, key);
	socket.data.connection = connection;
	// What the client sent behind the header, before its greeting.
	if (first && first.length > 0 && !proxied) {
		received(socket, settings, first);
	}
	begin(() => void connection.open());
}

/** Implicit TLS behind `proxyProtocol`: `node:tls` over the raw socket, bounded by `handshakeTimeout`. */
function startTls(
	listening: Listening,
	socket: Socket<SocketState>,
	tls: TlsHolder,
): ProxiedTls {
	const { settings } = listening;
	socket.data.handshaking = true;
	socket.timeout(settings.handshakeTimeout);
	const proxied = new ProxiedTls(socket as Socket<unknown>, tls.context, {
		secure: () => handshake(listening, socket, true),
		data: (bytes) => received(socket, settings, bytes),
		drain: () => socket.data.transport?.drain(),
	});
	socket.data.tls = proxied;
	return proxied;
}

/**
 * Implicit TLS without a proxy: the listener is clear and each socket is
 * upgraded as it opens, with the pair in use then, so a pair `setTls`
 * replaced applies to the next connection and not to the open ones. The
 * encrypted socket has the handlers of a TLS listener's; the clear one
 * only carries the TLS records, which the encrypted one reads.
 */
export function upgradingHandlers(
	encrypted: SocketHandler<SocketState>,
	settings: Settings,
): SocketHandler<SocketState> {
	const ignore = () => {};
	return {
		open(raw) {
			const tls = settings.tls?.options;
			if (!tls) return raw.terminate();
			try {
				raw.upgradeTLS<SocketState>({
					tls: { key: tls.key, cert: tls.cert },
					data: { upgraded: false },
					socket: encrypted,
				});
			} catch {
				raw.terminate();
			}
		},
		data: ignore,
		drain: ignore,
		close: ignore,
		error: ignore,
		timeout: ignore,
	};
}
