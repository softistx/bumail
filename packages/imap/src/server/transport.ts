import type { Socket } from 'bun';

/** What a connection needs from its socket: Bun's, or a fake one in specs. */
export interface Transport {
	readonly remoteAddress: string;
	readonly secure: boolean;
	/** Queues bytes for the client; what the socket cannot take now is kept for `drain`. */
	write(bytes: Uint8Array): void;
	/** Bytes written but not yet taken by the socket. */
	readonly backlog: number;
	/** Resolves once everything written has left. */
	drained(): Promise<void>;
	/**
	 * Hangs up once everything written has left, and terminates the socket
	 * after a short grace if it has not closed by then — whether bytes were
	 * queued or not: a hang-up never waits on the client.
	 */
	end(): void;
	/** Hangs up now, dropping whatever the client has not taken. */
	abort(): void;
	/** Stops reading from the client, while the server catches up. */
	pause(): void;
	resume(): void;
	/** Starts TLS on the connection, once the OK to STARTTLS has left. */
	startTls(): void;
}

/** How long a hang-up waits for the client to take what is queued, and to close. */
export const CLOSE_GRACE = 5000;

/**
 * A Bun socket as a Transport. Bun's sockets do not buffer: `write` takes
 * what the kernel takes and says how much. The rest waits here for the
 * `drain` event; a writer that cares awaits `drained` before writing more.
 *
 * A hang-up is bounded: `end` waits `CLOSE_GRACE` at most for the queue to
 * leave and the socket to close, `abort` does not wait at all. A client
 * that never reads is cut all the same, on TLS too, and gives back its
 * place under `maxConnections`.
 *
 * Adapted from `@bumail/smtp`'s own (`src/server/transport.ts`), which
 * writes text: the two are internal, and differ in what they carry.
 */
export class SocketTransport implements Transport {
	readonly #socket: Socket<unknown>;
	readonly remoteAddress: string;
	readonly secure: boolean;
	readonly #startTls: () => void;
	#queue: Uint8Array[] = [];
	#backlog = 0;
	#waiters: (() => void)[] = [];
	#ending = false;
	#grace: ReturnType<typeof setTimeout> | undefined;

	constructor(
		socket: Socket<unknown>,
		secure: boolean,
		startTls: () => void,
		remoteAddress = socket.remoteAddress,
	) {
		this.#socket = socket;
		this.secure = secure;
		this.#startTls = startTls;
		this.remoteAddress = remoteAddress;
	}

	get backlog(): number {
		return this.#backlog;
	}

	write(bytes: Uint8Array): void {
		if (this.#queue.length > 0) {
			this.#queue.push(bytes);
			this.#backlog += bytes.length;
			return;
		}
		const written = this.#socket.write(bytes);
		if (written < bytes.length) {
			this.#queue.push(bytes.subarray(Math.max(written, 0)));
			this.#backlog += bytes.length - Math.max(written, 0);
		}
	}

	/** Bun's `drain`: the socket can take more. */
	drain(): void {
		while (this.#queue.length > 0) {
			const bytes = this.#queue[0] as Uint8Array;
			const written = Math.max(this.#socket.write(bytes), 0);
			this.#backlog -= written;
			if (written < bytes.length) {
				this.#queue[0] = bytes.subarray(written);
				return;
			}
			this.#queue.shift();
		}
		for (const wake of this.#waiters.splice(0)) wake();
		if (this.#ending) this.#socket.shutdown();
	}

	drained(): Promise<void> {
		if (this.#queue.length === 0) return Promise.resolve();
		return new Promise((wake) => this.#waiters.push(wake));
	}

	/** The socket closed: nothing more will leave. */
	closed(): void {
		clearTimeout(this.#grace);
		this.#queue = [];
		this.#backlog = 0;
		for (const wake of this.#waiters.splice(0)) wake();
	}

	/**
	 * Shuts the socket's writing side now when nothing is queued, else once
	 * the queue leaves; either way the grace timer terminates the socket if
	 * `close` has not come by then. Not Bun's `end`: on TLS, it waits for
	 * the client's own close, which a client that stopped reading never
	 * sends, and a `terminate` after it no longer closes the socket (Bun
	 * 1.4). `shutdown` lets the client read to the end and close, and
	 * leaves `terminate` able to cut it when it does not.
	 */
	end(): void {
		if (this.#ending) return;
		this.#ending = true;
		this.#grace = setTimeout(() => this.abort(), CLOSE_GRACE);
		if (this.#queue.length === 0) this.#socket.shutdown();
	}

	abort(): void {
		this.closed();
		this.#socket.terminate();
	}

	pause(): void {
		this.#socket.pause();
	}

	resume(): void {
		this.#socket.resume();
	}

	startTls(): void {
		this.#startTls();
	}
}
