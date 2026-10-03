import type { Socket } from 'bun';

/** What a connection needs from its socket: Bun's, or a fake one in specs. */
export interface Transport {
	readonly remoteAddress: string;
	readonly secure: boolean;
	/** Queues text for the client; what the socket cannot take now is kept for `drain`. */
	write(text: string): void;
	/** Resolves once everything written has left. */
	drained(): Promise<void>;
	/** Hangs up once everything written has left. */
	end(): void;
	/** Stops reading from the client, while the server catches up. */
	pause(): void;
	resume(): void;
	/** Starts TLS on the connection, once the 220 to STARTTLS has left. */
	startTls(): void;
	/** Starts the idle time again, as a byte from the client does. */
	restartIdle(seconds: number): void;
}

/**
 * A Bun socket as a Transport. Bun's sockets do not buffer: `write` takes
 * what the kernel takes and says how much. The rest waits here for the
 * `drain` event, so no reply is lost to a client that reads slowly.
 */
export class SocketTransport implements Transport {
	readonly #socket: Socket<unknown>;
	readonly remoteAddress: string;
	readonly secure: boolean;
	readonly #startTls: () => void;
	#queue: Uint8Array[] = [];
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

	write(text: string): void {
		const bytes = new TextEncoder().encode(text);
		if (this.#queue.length > 0) {
			this.#queue.push(bytes);
			return;
		}
		const written = this.#socket.write(bytes);
		if (written < bytes.length) this.#queue.push(bytes.subarray(written));
	}

	/** Bun's `drain`: the socket can take more. */
	drain(): void {
		while (this.#queue.length > 0) {
			const bytes = this.#queue[0] as Uint8Array;
			const written = this.#socket.write(bytes);
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

	restartIdle(seconds: number): void {
		this.#socket.timeout(seconds);
	}
}
