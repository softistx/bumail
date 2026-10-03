import type { Socket, SocketHandler } from 'bun';
import { SmtpError } from '../errors';
import { Outgoing } from '../io/outgoing';
import type { Reply } from '../protocol/reply';
import { Inbox } from './inbox';
import {
	type Clock,
	type Endpoint,
	reason,
	type TlsTarget,
	tlsOptions,
} from './target';

/**
 * A connection to an SMTP server: replies read as they come into an
 * `Inbox`, which bounds them, every wait bounded by its timeout and the deadline. Whatever the server
 * does ends in a reply or an `SmtpError`, never in an exception of Bun's.
 */
export class ClientSocket {
	readonly host: string;
	readonly #clock: Clock;
	#socket: Socket<undefined> | undefined;
	#outgoing = new Outgoing(() => 0);
	/** Which socket's events count: the clear one's, or the TLS one's after STARTTLS. */
	#tls = false;
	readonly #inbox = new Inbox();
	#failure: SmtpError | undefined;
	#closed = false;
	#wake: (() => void) | undefined;
	#handshaking: ((ok: boolean, error: unknown) => void) | undefined;
	secure = false;
	/** The certificate checked out against the host name. */
	verified = false;

	private constructor(host: string, clock: Clock) {
		this.host = host;
		this.#clock = clock;
	}

	/** Connects, with TLS from the first byte when `tls` is given. */
	static async open(
		endpoint: Endpoint,
		tls: TlsTarget | undefined,
		seconds: number,
		clock: Clock,
	): Promise<ClientSocket> {
		const client = new ClientSocket(endpoint.host, clock);
		client.#tls = tls !== undefined;
		const handshake = tls ? client.#expectHandshake(tls) : undefined;
		handshake?.catch(() => {});
		const { address, port } = endpoint;
		const connecting = Bun.connect({
			hostname: address,
			port,
			...(tls ? { tls: tlsOptions(tls) } : {}),
			socket: client.#handlers(tls !== undefined),
		});
		try {
			client.#use(await client.#race(connecting, seconds, 'the connection'));
		} catch (error) {
			connecting.then(
				(socket) => socket.terminate(),
				() => {},
			);
			if (error instanceof SmtpError) throw error;
			throw new SmtpError(
				'CONNECTION_FAILED',
				`Could not connect to ${endpoint.host} (${address}:${port}): ${reason(error)}`,
			);
		}
		if (handshake) await client.#race(handshake, seconds, 'the TLS handshake');
		return client;
	}

	#use(socket: Socket<undefined>): void {
		this.#socket = socket;
		this.#outgoing = new Outgoing((bytes) => socket.write(bytes));
	}

	#handlers(tls: boolean): SocketHandler<undefined> {
		const live = () => this.#tls === tls;
		return {
			data: (_, chunk) => {
				if (live()) this.#receive(chunk);
			},
			drain: () => {
				if (live()) this.#outgoing.drain();
			},
			close: () => {
				if (live()) this.#lost();
			},
			error: () => {
				if (live()) this.#lost();
			},
			handshake: (_, ok, error) => {
				if (live()) this.#handshaking?.(ok, error);
			},
		};
	}

	#expectHandshake(tls: TlsTarget): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#handshaking = (ok, error) => {
				this.#handshaking = undefined;
				if (this.#closed || (tls.verify && !ok)) {
					const why = this.#closed ? 'the connection closed' : reason(error);
					return reject(
						this.#fail(
							new SmtpError(
								'TLS_FAILED',
								`TLS with ${this.host} failed: ${why}`,
							),
						),
					);
				}
				this.secure = true;
				this.verified = ok && error === null;
				resolve();
			};
		});
	}

	#receive(chunk: Uint8Array): void {
		if (this.#failure || this.#closed) return;
		const wrong = this.#inbox.push(chunk);
		if (wrong) this.#fail(this.#bad(wrong));
		else this.#wakeUp();
	}

	#bad(what: string): SmtpError {
		return new SmtpError('BAD_REPLY', `${this.host} sent ${what}`);
	}

	#wakeUp(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	#lost(): void {
		this.#closed = true;
		this.#outgoing.clear();
		this.#handshaking?.(false, null);
		this.#wakeUp();
	}

	/** Records the first failure, hangs up, and returns it to throw. */
	#fail(error: SmtpError): SmtpError {
		this.#failure ??= error;
		this.#socket?.terminate();
		this.#lost();
		return this.#failure;
	}

	/** `promise`, or a `TIMEOUT` past `seconds` or the deadline, whichever comes first. */
	#race<T>(promise: Promise<T>, seconds: number, what: string): Promise<T> {
		const { host } = this;
		return this.#clock.race(promise, seconds, (deadline) =>
			this.#fail(
				new SmtpError(
					'TIMEOUT',
					deadline
						? `The deadline of ${this.#clock.seconds} s passed waiting for ${what} (${host})`
						: `Timed out after ${seconds} s waiting for ${what} (${host})`,
				),
			),
		);
	}

	/** The next reply; `what` names it in errors: `the greeting`, `the reply to MAIL FROM`. */
	async reply(what: string, seconds: number): Promise<Reply> {
		for (;;) {
			const next = this.#inbox.shift();
			if (next) return next;
			if (this.#failure) throw this.#failure;
			if (this.#closed) {
				throw this.#fail(
					new SmtpError(
						'CONNECTION_LOST',
						`The connection to ${this.host} closed before ${what}`,
					),
				);
			}
			await this.#race(
				new Promise<void>((wake) => {
					this.#wake = wake;
				}),
				seconds,
				what,
			);
		}
	}

	/** Queues bytes for the server; nothing once the connection failed. */
	write(data: Uint8Array | string): void {
		if (this.#failure || this.#closed) return;
		this.#outgoing.write(
			typeof data === 'string' ? new TextEncoder().encode(data) : data,
		);
	}

	/** Waits until the server took everything written. */
	async drained(seconds: number): Promise<void> {
		await this.#race(
			this.#outgoing.drained(),
			seconds,
			'the server to take the message',
		);
		if (this.#failure) throw this.#failure;
		if (this.#closed) {
			throw this.#fail(
				new SmtpError(
					'CONNECTION_LOST',
					`The connection to ${this.host} closed while the message was sent`,
				),
			);
		}
	}

	/** After the 220 to STARTTLS: TLS on this connection. Anything the server sent past the 220 is an attack. */
	async startTls(tls: TlsTarget, seconds: number): Promise<void> {
		const socket = this.#socket;
		if (this.#inbox.holding || !socket) {
			throw this.#fail(this.#bad('more after its 220 to STARTTLS'));
		}
		const handshake = this.#expectHandshake(tls);
		handshake.catch(() => {});
		this.#tls = true;
		const [, encrypted] = socket.upgradeTLS<undefined>({
			tls: tlsOptions(tls),
			socket: this.#handlers(true),
		});
		this.#use(encrypted);
		await this.#race(handshake, seconds, 'the TLS handshake');
	}

	/** Hangs up. */
	close(): void {
		this.#closed = true;
		this.#socket?.end();
	}

	/** Hangs up at once: a message cut short is not delivered. */
	abort(): void {
		this.#closed = true;
		this.#socket?.terminate();
	}
}
