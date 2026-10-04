/** The most nonces kept for later requests. */
export const MAX_NONCES = 16;

/**
 * The `Replay-Nonce`s answers gave (RFC 8555 §6.5), kept for the next
 * signed requests: the newest is used first, and past `MAX_NONCES` the
 * oldest is dropped, as the most likely to have expired.
 */
export class NoncePool {
	readonly #nonces: string[] = [];

	/** Keeps a nonce an answer gave. */
	keep(nonce: string): void {
		this.#nonces.push(nonce);
		if (this.#nonces.length > MAX_NONCES) this.#nonces.shift();
	}

	/** The newest nonce kept, taken out of the pool; undefined when none is left. */
	take(): string | undefined {
		return this.#nonces.pop();
	}

	get size(): number {
		return this.#nonces.length;
	}
}
