/**
 * What waits to leave a Bun socket. Bun's sockets do not buffer: `write`
 * takes what the kernel takes and says how much. The rest waits here for
 * the socket's `drain` event, so nothing written is lost to a client that
 * reads slowly; a writer that cares awaits `drained` before writing more.
 *
 * Adapted from `@bumail/smtp`'s own (`src/io/outgoing.ts`), which does not
 * count its `backlog`: the server's connection here holds its writes past
 * a high-water mark.
 */
export class Outgoing {
	readonly #write: (bytes: Uint8Array) => number;
	#queue: Uint8Array[] = [];
	#backlog = 0;
	#waiters: (() => void)[] = [];

	constructor(write: (bytes: Uint8Array) => number) {
		this.#write = write;
	}

	/** Nothing waits to leave. */
	get empty(): boolean {
		return this.#queue.length === 0;
	}

	/** Bytes written but not yet taken by the socket. */
	get backlog(): number {
		return this.#backlog;
	}

	/** Writes what the socket takes now, and keeps the rest for `drain`. */
	write(bytes: Uint8Array): void {
		if (this.#queue.length > 0) {
			this.#queue.push(bytes);
			this.#backlog += bytes.length;
			return;
		}
		const written = Math.max(this.#write(bytes), 0);
		if (written < bytes.length) {
			this.#queue.push(bytes.subarray(written));
			this.#backlog += bytes.length - written;
		}
	}

	/** The socket's `drain`: it can take more. True once everything has left. */
	drain(): boolean {
		while (this.#queue.length > 0) {
			const bytes = this.#queue[0] as Uint8Array;
			const written = Math.max(this.#write(bytes), 0);
			this.#backlog -= written;
			if (written < bytes.length) {
				this.#queue[0] = bytes.subarray(written);
				return false;
			}
			this.#queue.shift();
		}
		for (const wake of this.#waiters.splice(0)) wake();
		return true;
	}

	/** Resolves once everything written has left, or the socket closed. */
	drained(): Promise<void> {
		if (this.#queue.length === 0) return Promise.resolve();
		return new Promise((wake) => this.#waiters.push(wake));
	}

	/** Drops what is queued, and lets go whoever waited for it. */
	clear(): void {
		this.#queue = [];
		this.#backlog = 0;
		for (const wake of this.#waiters.splice(0)) wake();
	}
}
