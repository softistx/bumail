/**
 * The connections a server holds, and how many each client holds, by
 * `clientKey`. `release` is idempotent: every close handler calls it.
 */
export class Slots<T> {
	readonly #open = new Map<T, string | undefined>();
	readonly #perClient = new Map<string, number>();

	get size(): number {
		return this.#open.size;
	}

	/** How many connections the client `key` holds. */
	of(key: string | undefined): number {
		return key === undefined ? 0 : (this.#perClient.get(key) ?? 0);
	}

	take(connection: T, key: string | undefined): void {
		this.#open.set(connection, key);
		if (key !== undefined) this.#perClient.set(key, this.of(key) + 1);
	}

	release(connection: T): void {
		if (!this.#open.has(connection)) return;
		const key = this.#open.get(connection);
		this.#open.delete(connection);
		if (key === undefined) return;
		const left = this.of(key) - 1;
		if (left > 0) this.#perClient.set(key, left);
		else this.#perClient.delete(key);
	}

	connections(): T[] {
		return [...this.#open.keys()];
	}
}
