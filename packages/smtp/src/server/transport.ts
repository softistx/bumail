import type { Socket } from 'bun';
import { Outgoing } from '../io/outgoing';

/** What a connection needs from its socket: Bun's, or a fake one in specs. */
export interface Transport {
	readonly remoteAddress: string;
	readonly secure: boolean;
	/** Queues text for the client; what the socket cannot take now is kept for `drain`. */
	write(text: string): void;
	/** Resolves once everything written has left. */
	drained(): Promise<void>;
	/**
	 * Hangs up once everything written has left: a graceful close, as after
	 * QUIT. A socket not closed within `CLOSE_GRACE_MS` is terminated.
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
	/** Starts TLS on the connection, once the 220 to STARTTLS has left. */
	startTls(): void;
	/** Starts the idle time again, as a byte from the client does. */
	restartIdle(seconds: number): void;
}

/**
 * How long any end may wait on the client — for what is queued to leave,
 * then for the close itself — before the socket is terminated.
 */
export const CLOSE_GRACE_MS = 5_000;

/**
 * A Bun socket as a Transport. What the socket cannot take now waits in an
 * `Outgoing` for the `drain` event, so no reply is lost to a client that
 * reads slowly.
 */
export class SocketTransport implements Transport {
	readonly #socket: Socket<unknown>;
	readonly remoteAddress: string;
	readonly secure: boolean;
	readonly #startTls: () => void;
	readonly #outgoing: Outgoing;
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
		this.#outgoing = new Outgoing((bytes) => socket.write(bytes));
	}

	write(text: string): void {
		if (this.#closed) return;
		this.#outgoing.write(new TextEncoder().encode(text));
	}

	/** Bun's `drain`: the socket can take more. */
	drain(): void {
		if (this.#outgoing.drain() && this.#ending) this.#hangUp();
	}

	drained(): Promise<void> {
		return this.#outgoing.drained();
	}

	/** The socket closed: nothing more will leave. */
	closed(): void {
		this.#closed = true;
		this.#disarm();
		this.#outgoing.clear();
	}

	/** After `closed()`, does nothing: no grace is armed on a dead socket. */
	end(): void {
		if (this.#closed) return;
		this.#arm();
		if (this.#outgoing.empty) this.#hangUp();
		else this.#ending = true;
	}

	abort(): void {
		if (this.#closed) return;
		if (this.#outgoing.empty) this.end();
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
	 */
	#hangUp(): void {
		this.#socket.shutdown(true);
	}

	/** Drops what is queued and resets the connection. */
	#terminate(): void {
		this.#disarm();
		this.#outgoing.clear();
		this.#socket.terminate();
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

	restartIdle(seconds: number): void {
		this.#socket.timeout(seconds);
	}
}
