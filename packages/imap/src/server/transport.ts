import type { Socket } from 'bun';
import { Outgoing } from '../io/outgoing';

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
	 * If the server paused reading, it reads again first, since a half-close
	 * does not complete over input left unread.
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
 * A hang-up while the server paused reading lingers: it reads again and
 * drops what the client sent until nothing came for `LINGER_QUIET_MS`,
 * then half-closes. Bun closes the socket at once on `shutdown(true)`, and
 * Linux answers a close over unread input with a reset that loses the last
 * reply. A client still sending after `LINGER_MAX_MS` is reset.
 */
export const LINGER_QUIET_MS = 20;
export const LINGER_MAX_MS = 500;

/**
 * A Bun socket as a Transport. What the socket cannot take now waits in an
 * `Outgoing` for the `drain` event, so no output is lost to a client that
 * reads slowly; a writer that cares awaits `drained` before writing more.
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
	readonly #outgoing: Outgoing;
	#ending = false;
	/** The socket closed: every later write, end or abort is a no-op. */
	#closed = false;
	/** The server stopped reading: what the client sends waits in the socket. */
	#paused = false;
	#grace: ReturnType<typeof setTimeout> | undefined;
	/** A paused hang-up waiting for the client's input to stop: how it will shut down, when it stops waiting, its timer. */
	#linger:
		| {
				drained: boolean;
				until: number;
				timer?: ReturnType<typeof setTimeout>;
		  }
		| undefined;

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

	get backlog(): number {
		return this.#outgoing.backlog;
	}

	write(bytes: Uint8Array): void {
		if (this.#closed) return;
		this.#outgoing.write(bytes);
	}

	/** Bun's `drain`: the socket can take more. */
	drain(): void {
		if (this.#outgoing.drain() && this.#ending) this.#hangUp(true);
	}

	drained(): Promise<void> {
		return this.#outgoing.drained();
	}

	/**
	 * Bun's `data`: the client sent bytes. While a hang-up lingers, they are
	 * dropped, and the half-close waits until they stop — `LINGER_MAX_MS` at
	 * most: a client still sending then is reset. Re-arming the timer on each
	 * chunk would let a client that never pauses keep it from firing, and a
	 * half-close over its input may never fire `close` (Linux).
	 */
	received(): void {
		const linger = this.#linger;
		if (!linger) return;
		const left = linger.until - Date.now();
		if (left <= 0) this.#terminate();
		else this.#lingerFor(Math.min(LINGER_QUIET_MS, left));
	}

	/** The socket closed: nothing more will leave. */
	closed(): void {
		this.#closed = true;
		this.#disarm();
		this.#stopLingering();
		this.#outgoing.clear();
	}

	/** After `closed()`, does nothing: no grace is armed on a dead socket. */
	end(): void {
		if (this.#closed) return;
		this.#arm();
		if (this.#outgoing.empty) this.#hangUp(false);
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
	 *
	 * Except on TLS right after a queue drained (`drained`): there the last
	 * write may still sit in Bun's own TLS buffer, which a half-close drops
	 * (Bun 1.4.2: up to 96 KiB lost by a client reading slowly). The client
	 * was reading a moment ago, so a full `shutdown()` closes once it
	 * answers, and the grace bounds it if it stops.
	 *
	 * Reading paused, it reads again first: over input the server never
	 * read, a half-close does not fire `close` (Bun 1.4.2), and the slot
	 * waited for the grace. And it lingers: Bun closes the socket as soon as
	 * it half-closes, and on Linux a close with input still unread is a
	 * reset, which loses the last reply. So it drops what the client sends
	 * until that stops for `LINGER_QUIET_MS` (`LINGER_MAX_MS` at most), then
	 * half-closes: `close` fires at once, and a client that stopped sending
	 * still gets the last reply and the end. One still sending at
	 * `LINGER_MAX_MS` is reset (`received()`).
	 */
	#hangUp(drained: boolean): void {
		this.#ending = false;
		if (this.#linger) return;
		if (!this.#paused) {
			this.#shutdown(drained);
			return;
		}
		this.resume();
		this.#linger = { drained, until: Date.now() + LINGER_MAX_MS };
		this.#lingerFor(LINGER_QUIET_MS);
	}

	/**
	 * Half-closes in `ms`, unless the client sends again first. Armed for
	 * less than `LINGER_QUIET_MS`, the input never went quiet before
	 * `LINGER_MAX_MS`: it resets instead.
	 */
	#lingerFor(ms: number): void {
		const linger = this.#linger;
		if (!linger) return;
		clearTimeout(linger.timer);
		linger.timer = setTimeout(() => {
			if (ms < LINGER_QUIET_MS) return this.#terminate();
			this.#stopLingering();
			this.#shutdown(linger.drained);
		}, ms);
		linger.timer.unref?.();
	}

	#stopLingering(): void {
		clearTimeout(this.#linger?.timer);
		this.#linger = undefined;
	}

	#shutdown(drained: boolean): void {
		if (drained && this.secure) this.#socket.shutdown();
		else this.#socket.shutdown(true);
	}

	/** Drops what is queued and resets the connection. */
	#terminate(): void {
		this.#disarm();
		this.#stopLingering();
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
		this.#paused = true;
		this.#socket.pause();
	}

	resume(): void {
		this.#paused = false;
		this.#socket.resume();
	}

	startTls(): void {
		this.#startTls();
	}
}
