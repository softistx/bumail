import { createSecureContext, type SecureContext } from 'node:tls';
import type { Socket, TCPSocketListener } from 'bun';
import { ImapError } from '../errors';
import { listenerHandlers } from './admission';
import type { Connection } from './connection';
import { handlers, type SocketState, stateOf } from './listener';
import type { ImapServerOptions, TlsOptions } from './options';
import { settingsOf } from './settings';

/** The `node:tls` context implicit TLS behind a proxy runs on: `tls` read whole, files included. */
async function proxyContext(tls: TlsOptions): Promise<SecureContext> {
	const read = async (value: TlsOptions['key']) =>
		typeof value === 'string'
			? value
			: Buffer.from(value instanceof Uint8Array ? value : await value.bytes());
	return createSecureContext({
		key: await read(tls.key),
		cert: await read(tls.cert),
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
			// Implicit TLS behind a proxy: a clear listener, TLS after the header.
			const proxied =
				secure && settings.trusts ? await proxyContext(options.tls) : undefined;
			listener = Bun.listen<SocketState>({
				hostname,
				port,
				...(secure && !proxied
					? { tls: { key: options.tls.key, cert: options.tls.cert } }
					: {}),
				socket: {
					...handlers(settings),
					...listenerHandlers({
						settings,
						open,
						handshaking,
						secure,
						...(proxied ? { proxied } : {}),
					}),
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
