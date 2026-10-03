/** A count of slots: who asks past it waits, first come first served. */
export class Limiter {
	readonly #size: number;
	#used = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(size: number) {
		this.#size = size;
	}

	/** A slot, once one is free; call what it resolves to, once, to give it back. */
	async acquire(): Promise<() => void> {
		if (this.#used >= this.#size) {
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		} else {
			this.#used++;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiting.shift();
			// The slot passes to the next in line without being freed in between.
			if (next) next();
			else this.#used--;
		};
	}
}

/** One `Limiter` per key, made when first asked for and dropped once idle. */
export class KeyedLimiter {
	readonly #size: number;
	readonly #limiters = new Map<string, { limiter: Limiter; users: number }>();

	constructor(size: number) {
		this.#size = size;
	}

	async acquire(key: string): Promise<() => void> {
		let entry = this.#limiters.get(key);
		if (!entry) {
			entry = { limiter: new Limiter(this.#size), users: 0 };
			this.#limiters.set(key, entry);
		}
		entry.users++;
		const release = await entry.limiter.acquire();
		const held = entry;
		return () => {
			release();
			if (--held.users === 0) this.#limiters.delete(key);
		};
	}
}
