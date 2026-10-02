import type { Socket, TCPSocketListener } from 'bun';
import { reply } from '../protocol/reply';
import { Connection, type Transport } from './connection';
import type { SmtpServerOptions } from './options';
import { type Settings, settingsOf } from './settings';

interface SocketState {
	connection?: Connection;
	/** Bytes on the raw socket after STARTTLS are the TLS stream itself: ignored. */
	upgraded: boolean;
}

export interface SmtpServer {
	/** Starts listening; resolves once the port is bound. */
	listen(options: {
		port: number;
		hostname?: string;
	}): Promise<{ port: number; hostname: string }>;
	/** Stops listening; `closeConnections` hangs up on every client too. */
	stop(closeConnections?: boolean): void;
	/** Open connections. */
	readonly connections: number;
}

function transportOf(
	socket: Socket<SocketState>,
	settings: Settings,
	secure: boolean,
): Transport {
	return {
		remoteAddress: socket.remoteAddress,
		secure,
		write: (text) => {
			socket.write(text);
		},
		end: () => {
			socket.end();
		},
		startTls: () => {
			const tls = settings.options.tls;
			if (!tls) return;
			socket.data.upgraded = true;
			const connection = socket.data.connection as Connection;
			const [, encrypted] = socket.upgradeTLS<SocketState>({
				tls: { key: tls.key, cert: tls.cert },
				data: { connection, upgraded: false },
				socket: {
					data: (_, chunk) => connection.receive(chunk),
					close: () => connection.close(),
					error: () => connection.close(),
					timeout: (s) => {
						connection.close(
							reply(
								421,
								'4.4.2',
								`${settings.options.hostname} Idle too long, closing`,
							),
						);
						s.end();
					},
				},
			});
			encrypted.timeout(settings.timeout);
			connection.useTransport({
				...transportOf(encrypted, settings, true),
				remoteAddress: socket.remoteAddress,
			});
		},
	};
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
	let open = 0;
	const secure = options.implicitTls === true;
	return {
		get connections() {
			return open;
		},
		async listen({ port, hostname = '0.0.0.0' }) {
			listener = Bun.listen<SocketState>({
				hostname,
				port,
				...(secure && options.tls
					? { tls: { key: options.tls.key, cert: options.tls.cert } }
					: {}),
				socket: {
					open(socket) {
						socket.data = { upgraded: false };
						socket.timeout(settings.timeout);
						if (open >= settings.maxConnections) {
							socket.end(
								`421 4.3.2 ${options.hostname} Too many connections, try later\r\n`,
							);
							return;
						}
						open++;
						const connection = new Connection(
							settings,
							transportOf(socket, settings, secure),
						);
						socket.data.connection = connection;
						void connection.open();
					},
					data(socket, chunk) {
						if (!socket.data.upgraded) socket.data.connection?.receive(chunk);
					},
					close(socket) {
						if (socket.data.connection) open--;
						socket.data.connection?.close();
					},
					error(socket) {
						socket.data.connection?.close();
					},
					timeout(socket) {
						if (socket.data.upgraded) return;
						socket.data.connection?.close(
							reply(421, '4.4.2', `${options.hostname} Idle too long, closing`),
						);
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
