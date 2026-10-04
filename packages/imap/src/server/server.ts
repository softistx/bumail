import type { Socket, TCPSocketListener } from 'bun';
import { ImapError } from '../errors';
import { type Listening, listenerHandlers } from './admission';
import type { Connection } from './connection';
import { handlers, type SocketState, stateOf } from './listener';
import type { ImapServerOptions } from './options';
import { settingsOf } from './settings';
import { tlsContext } from './tls-context';

/** A key or certificate `listen` cannot use: `INVALID_OPTION`, the reason as its `cause`. */
const invalidTls = (message: string, cause: unknown) =>
	new ImapError('INVALID_OPTION', message, { cause });

/** What a `listen` that a `stop()` came before says. */
const STOPPED = 'listen(): stop() was called before the server bound its port';

/** Binds the port, once `listen`'s guard passed. */
async function bind(
	options: ImapServerOptions,
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
		throw new ImapError('STOPPED', STOPPED);
	}
	// Behind a proxy: a clear listener, TLS after the header.
	const proxied = listening.settings.trusts ? context : undefined;
	return Bun.listen<SocketState>({
		hostname,
		port,
		...(listening.secure && !proxied
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
	/** `listen` has not resolved yet: it may be reading the TLS material, before it binds. */
	let starting = false;
	/** `stop()` was called while `starting`: `listen` leaves nothing bound. */
	let stopRequested = false;
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
			if (listener || starting) {
				throw new ImapError(
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
				const bound = await bind(
					options,
					{ settings, open, handshaking, secure },
					port,
					hostname,
					() => stopRequested,
				);
				// `stop()` came before `listen` resolved: nothing is left listening.
				if (stopRequested) {
					bound.stop(true);
					throw new ImapError('STOPPED', STOPPED);
				}
				listener = bound;
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
