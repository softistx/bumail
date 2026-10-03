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
	 * Hangs up once everything written has left: a graceful close, as after
	 * LOGOUT. A socket not closed within `CLOSE_GRACE_MS` is terminated.
	 */
	end(): void;
	/**
	 * Hangs up now, the server's decision: what the socket already took
	 * leaves, but what still waits for a client that stopped reading is
	 * dropped and the connection reset, so the close never hangs on it.
	 * With nothing queued it hangs up as `end()` does, within the same grace.
	 */
	abort(): void;
	/** Stops reading from the client, while the server catches up. */
	pause(): void;
	resume(): void;
	/** Starts TLS on the connection, once the OK to STARTTLS has left. */
	startTls(): void;
}

/**
 * How long any end may wait on the client — for what is queued to leave,
 * then for the close itself — before the socket is terminated.
 */
export const CLOSE_GRACE_MS = 5_000;

/**
 * A Bun socket as a Transport. Bun's sockets do not buffer: `write` takes
 * what the kernel takes and says how much. The rest waits here for the
 * `drain` event; a writer that cares awaits `drained` before writing more.
 *
 * Adapted from `@bumail/smtp`'s own (`src/server/transport.ts`), which
 * writes text: the two are internal, and differ in what they carry, not in
 * how they hang up. A fix to one is a fix to the other.
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
	/** The socket closed: every later write, end or abort is a no-op. */
	#closed = false;
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
		if (this.#closed) return;
		if (this.#queue.length > 0) {
			this.#queue.push(bytes);
			this.#backlog += bytes.length;
			return;
		}
		const written = Math.max(this.#socket.write(bytes), 0);
		if (written < bytes.length) {
			this.#queue.push(bytes.subarray(written));
			this.#backlog += bytes.length - written;
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
		if (this.#ending) this.#hangUp(true);
	}

	drained(): Promise<void> {
		if (this.#queue.length === 0) return Promise.resolve();
		return new Promise((wake) => this.#waiters.push(wake));
	}

	/** The socket closed: nothing more will leave. */
	closed(): void {
		this.#closed = true;
		this.#disarm();
		this.#clear();
	}

	/** After `closed()`, does nothing: no grace is armed on a dead socket. */
	end(): void {
		if (this.#closed) return;
		this.#arm();
		if (this.#queue.length === 0) this.#hangUp(false);
		else this.#ending = true;
	}

	abort(): void {
		if (this.#closed) return;
		if (this.#queue.length === 0) this.end();
		else this.#terminate();
	}

	/**
	 * Hangs up with a half-close, `shutdown(true)`, not Bun's `end`: on TLS,
	 * `end` waits for the client's own close, which a client that stopped
	 * reading never sends, and a `terminate` after it no longer closes the
	 * socket (Bun 1.4). The half-close fires `close` at once, and a client
	 * that reads later still gets every byte, then the end. A full
	 * `shutdown()` would hold a paused client until the grace, then lose
	 * its last reply to the reset.
	 *
	 * Except on TLS right after a queue drained (`drained`): there the last
	 * write may still sit in Bun's own TLS buffer, which a half-close drops
	 * (Bun 1.4.2: up to 96 KiB lost by a client reading slowly). The client
	 * was reading a moment ago, so a full `shutdown()` closes once it
	 * answers, and the grace bounds it if it stops.
	 */
	#hangUp(drained: boolean): void {
		this.#ending = false;
		if (drained && this.secure) this.#socket.shutdown();
		else this.#socket.shutdown(true);
	}

	/** Drops what is queued and resets the connection. */
	#terminate(): void {
		this.#disarm();
		this.#clear();
		this.#socket.terminate();
	}

	/** Drops what is queued, and lets go whoever waited for it. */
	#clear(): void {
		this.#queue = [];
		this.#backlog = 0;
		for (const wake of this.#waiters.splice(0)) wake();
	}

	/** Terminates the socket once the grace is up, unless it closed first; the first deadline stands. */
	#arm(): void {
		if (this.#grace) return;
		this.#grace = setTimeout(() => this.#terminate(), CLOSE_GRACE_MS);
		this.#grace.unref?.();
	}

	#disarm(): void {
		clearTimeout(this.#grace);
		this.#grace = undefined;
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
