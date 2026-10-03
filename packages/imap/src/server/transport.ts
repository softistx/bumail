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
	/** Hangs up once everything written has left. */
	end(): void;
	/** Stops reading from the client, while the server catches up. */
	pause(): void;
	resume(): void;
	/** Starts TLS on the connection, once the OK to STARTTLS has left. */
	startTls(): void;
}

/**
 * A Bun socket as a Transport. Bun's sockets do not buffer: `write` takes
 * what the kernel takes and says how much. The rest waits here for the
 * `drain` event; a writer that cares awaits `drained` before writing more.
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
		if (this.#ending) this.#socket.end();
	}

	drained(): Promise<void> {
		if (this.#queue.length === 0) return Promise.resolve();
		return new Promise((wake) => this.#waiters.push(wake));
	}

	/** The socket closed: nothing more will leave. */
	closed(): void {
		this.#queue = [];
		this.#backlog = 0;
		for (const wake of this.#waiters.splice(0)) wake();
	}

	end(): void {
		if (this.#queue.length === 0) this.#socket.end();
		else this.#ending = true;
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
