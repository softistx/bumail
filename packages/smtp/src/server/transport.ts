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
		this.#outgoing.write(new TextEncoder().encode(text));
	}

	/** Bun's `drain`: the socket can take more. */
	drain(): void {
		if (this.#outgoing.drain() && this.#ending) this.#socket.end();
	}

	drained(): Promise<void> {
		return this.#outgoing.drained();
	}

	/** The socket closed: nothing more will leave. */
	closed(): void {
		this.#outgoing.clear();
	}

	end(): void {
		if (this.#outgoing.empty) this.#socket.end();
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
