import type { Socket, TCPSocketListener } from 'bun';
import { SmtpError } from '../errors';
import {
	type Listening,
	listenerHandlers,
	upgradingHandlers,
} from './admission';
import type { Connection } from './connection';
import { handlers, type SocketState } from './listener';
import type { SmtpServerOptions, TlsOptions } from './options';
import { settingsOf } from './settings';
import { Slots } from './slots';

/** A key or certificate `listen` or `setTls` cannot use: `INVALID_OPTION`, the reason as its `cause`. */
const invalidTls = (message: string, cause: unknown) =>
	new SmtpError('INVALID_OPTION', message, { cause });

/** What a `listen` that a `stop()` came before says. */
const STOPPED = 'listen(): stop() was called before the server bound its port';

/** Binds the port, once `listen`'s guard passed. */
async function bind(
	listening: Omit<Listening, 'proxied'>,
	port: number,
	hostname: string,
	stopped: () => boolean,
): Promise<TCPSocketListener<SocketState>> {
	// Implicit TLS: the key and certificate are checked first, so one
	// that cannot be used fails here alike, with a proxy or without.
	const { tls } = listening.settings;
	if (listening.secure && tls) await tls.load(invalidTls, 'listen()');
	// `stop()` came while the key was being read: nothing is bound.
	if (stopped()) {
		throw new SmtpError('STOPPED', STOPPED);
	}
	// Behind a proxy: a clear listener, TLS after the header. Without
	// one, the listener is clear too, and every socket upgrades at once:
	// the pair `setTls` replaced is read per connection, which a native
	// TLS listener, bound to one context, cannot do.
	const proxied =
		listening.secure && listening.settings.trusts ? tls : undefined;
	const full = {
		...handlers(listening.settings),
		...listenerHandlers({
			...listening,
			...(proxied ? { proxied } : {}),
		}),
	};
	return Bun.listen<SocketState>({
		hostname,
		port,
		socket:
			listening.secure && !proxied
				? upgradingHandlers(full, listening.settings)
				: full,
	});
}

export interface SmtpServer {
	/** Starts listening; resolves once the port is bound. Once only: a second call throws. */
	listen(options: {
		port: number;
		hostname?: string;
	}): Promise<{ port: number; hostname: string }>;
	/**
	 * Uses a renewed key and certificate from the next STARTTLS upgrade or
	 * implicit TLS connection on; the sessions open keep the TLS they have.
	 * The pair is read and checked first: one that cannot be used throws
	 * `INVALID_OPTION` and leaves the one in use. Needs a server made with
	 * `tls`.
	 */
	setTls(tls: TlsOptions): Promise<void>;
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
	/** `listen` has not resolved yet: it may be reading the TLS material, before it binds. */
	let starting = false;
	/** `stop()` was called while `starting`: `listen` leaves nothing bound. */
	let stopRequested = false;
	return {
		get connections() {
			return slots.size;
		},
		async setTls(tls) {
			if (!settings.tls) {
				throw new SmtpError(
					'INVALID_OPTION',
					'setTls(): the server was made without tls, so it has none to replace',
				);
			}
			await settings.tls.replace(tls, invalidTls, 'setTls()');
		},
		async listen({ port, hostname = '0.0.0.0' }) {
			if (listener || starting) {
				throw new SmtpError(
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
					{ settings, slots, handshaking, secure },
					port,
					hostname,
					() => stopRequested,
				);
				// `stop()` came before `listen` resolved: nothing is left listening.
				if (stopRequested) {
					bound.stop(true);
					throw new SmtpError('STOPPED', STOPPED);
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
