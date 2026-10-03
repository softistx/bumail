/**
 * How many requests each account has in flight, against a ceiling: the
 * session's `maxConcurrentRequests` or `maxConcurrentUpload`. Only accounts
 * with a request in flight are kept.
 */
export class Concurrency {
	readonly #max: number;
	readonly #running = new Map<string, number>();

	constructor(max: number) {
		this.#max = max;
	}

	/** Takes a slot for the account, or answers `false` when it has none left. */
	enter(accountId: string): boolean {
		const running = this.#running.get(accountId) ?? 0;
		if (running >= this.#max) return false;
		this.#running.set(accountId, running + 1);
		return true;
	}

	leave(accountId: string): void {
		const running = (this.#running.get(accountId) ?? 1) - 1;
		if (running <= 0) this.#running.delete(accountId);
		else this.#running.set(accountId, running);
	}

	/** Runs `work` in a slot, or answers `busy` when there is none. */
	async run<T>(
		accountId: string,
		work: () => Promise<T>,
		busy: () => T,
	): Promise<T> {
		if (!this.enter(accountId)) return busy();
		try {
			return await work();
		} finally {
			this.leave(accountId);
		}
	}
}
