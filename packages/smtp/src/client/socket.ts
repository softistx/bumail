import type { Socket, SocketHandler } from 'bun';
import { SmtpError } from '../errors';
import { Outgoing } from '../io/outgoing';
import type { Reply } from '../protocol/reply';
import { Inbox } from './inbox';
import { badReply, lost, refused, timedOut, tlsFailed } from './refusal';
import {
	type Clock,
	type Endpoint,
	reason,
	type TlsTarget,
	tlsOptions,
} from './target';

/**
 * A connection to an SMTP server: replies read as they come into an
 * `Inbox`, which bounds them; every wait bounded by its timeout and the
 * deadline. Whatever the server does ends in a reply or an `SmtpError`,
 * never in an exception of Bun's.
 */
export class ClientSocket {
	readonly host: string;
	readonly #clock: Clock;
	#socket: Socket<undefined> | undefined;
	#outgoing = new Outgoing(() => 0);
	/** Which socket's events count: the TLS one's after STARTTLS. */
	#tls = false;
	readonly #inbox = new Inbox();
	#failure: SmtpError | undefined;
	#closed = false;
	#wake: (() => void) | undefined;
	#handshaking: ((ok: boolean, error: unknown) => void) | undefined;
	/** Resolves when the connection is gone. */
	readonly #gone = Promise.withResolvers<void>();
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
		if (handshake) {
			// A handshake that failed before the connection resolved left it open.
			await client.#race(handshake, seconds, 'the TLS handshake').catch((e) => {
				client.close(true);
				throw e;
			});
		}
		return client;
	}

	#use(socket: Socket<undefined>): void {
		this.#socket = socket;
		this.#outgoing = new Outgoing((bytes) => socket.write(bytes));
	}

	/** Bun's events for one socket: only the live one's count, the clear one's or, after STARTTLS, the TLS one's. */
	#handlers(tls: boolean): SocketHandler<undefined> {
		const live =
			<A extends unknown[]>(run: (...args: A) => void) =>
			(...args: A) => {
				if (this.#tls === tls) run(...args);
			};
		return {
			data: live((_, chunk: Uint8Array) => this.#receive(chunk)),
			drain: live(() => this.#outgoing.drain()),
			close: live(() => this.#lost()),
			error: live(() => this.#lost()),
			handshake: live((_, ok: boolean, error: Error | null) =>
				this.#handshaking?.(ok, error),
			),
		};
	}

	#expectHandshake(tls: TlsTarget): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#handshaking = (ok, error) => {
				this.#handshaking = undefined;
				if (this.#closed || (tls.verify && !ok)) {
					const why = this.#closed ? 'the connection closed' : reason(error);
					return reject(this.#fail(tlsFailed(this.host, why)));
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
		if (wrong) this.#fail(badReply(this.host, wrong));
		else this.#wakeUp();
	}

	#wakeUp(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	#lost(): void {
		this.#closed = true;
		this.#gone.resolve();
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

	/**
	 * `promise`, or a `TIMEOUT` once `seconds` passed since `start` (now by
	 * default), or the deadline did, whichever comes first.
	 */
	#race<T>(
		promise: Promise<T>,
		seconds: number,
		what: string,
		start = performance.now(),
	): Promise<T> {
		const ms = start + seconds * 1000 - performance.now();
		const { host } = this;
		const deadline = this.#clock.seconds;
		return this.#clock.race(promise, ms, (passed) =>
			this.#fail(timedOut(host, what, seconds, passed ? deadline : undefined)),
		);
	}

	/** The next reply, within `seconds` all told; `what` names it in errors: `the greeting`, `the reply to MAIL FROM`. */
	async reply(what: string, seconds: number): Promise<Reply> {
		const start = performance.now();
		for (;;) {
			const next = this.#inbox.shift();
			if (next) return next;
			if (this.#failure) throw this.#failure;
			if (this.#closed) throw this.#fail(lost(this.host, what));
			await this.#race(
				new Promise<void>((wake) => {
					this.#wake = wake;
				}),
				seconds,
				what,
				start,
			);
		}
	}

	/** One of the caller's promises — the message stream's next part — bounded as a reply is, and cut short if the connection goes. */
	within<T>(promise: Promise<T>, seconds: number, what: string): Promise<T> {
		const gone = this.#gone.promise.then((): never => {
			throw this.#hungUp(lost(this.host, what));
		});
		return this.#race(Promise.race([promise, gone]), seconds, what);
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
		if (this.#failure || this.#closed) throw this.#hungUp(lost(this.host));
	}

	/** Why the connection is gone during DATA: its failure, the refusal a server sent before hanging up, or `lost`. */
	#hungUp(otherwise: SmtpError): SmtpError {
		if (this.#failure) return this.#failure;
		const said = this.#inbox.shift();
		return this.#fail(
			said ? refused(this.host, 'the message', said) : otherwise,
		);
	}

	/** After the 220 to STARTTLS: TLS on this connection. Anything the server sent past the 220 is an attack. */
	async startTls(tls: TlsTarget, seconds: number): Promise<void> {
		const socket = this.#socket;
		if (this.#inbox.holding || !socket) {
			throw this.#fail(badReply(this.host, 'more after its 220 to STARTTLS'));
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

	/** Hangs up; `now` at once, so a message cut short is not delivered. */
	close(now = false): void {
		this.#closed = true;
		if (now) this.#socket?.terminate();
		else this.#socket?.end();
	}
}
