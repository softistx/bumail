import { ServerError } from '../errors';

/** Verifies running at once, by default; the rest wait their turn. */
export const DEFAULT_MAX_VERIFIES = 4;
/** Verifies waiting, by default; past it, `authenticate` answers `busy`. */
export const DEFAULT_MAX_QUEUED_VERIFIES = 1000;

/**
 * At most `max` tasks at once; the others wait in order, at most
 * `maxQueued` of them. Argon2id takes 19 MiB and tens of milliseconds a
 * verify: without a cap, a burst of logins takes the memory and the CPU
 * of everything else.
 */
export class Gate {
	readonly #max: number;
	readonly #maxQueued: number;
	readonly #queue: (() => void)[] = [];
	#running = 0;

	constructor(
		max = DEFAULT_MAX_VERIFIES,
		maxQueued = DEFAULT_MAX_QUEUED_VERIFIES,
	) {
		if (!Number.isInteger(max) || max < 1) {
			throw new ServerError(
				'INVALID',
				'maxVerifies must be an integer of 1 or more',
			);
		}
		if (!Number.isInteger(maxQueued) || maxQueued < 0) {
			throw new ServerError(
				'INVALID',
				'maxQueuedVerifies must be an integer of 0 or more',
			);
		}
		this.#max = max;
		this.#maxQueued = maxQueued;
	}

	/** Tasks running now. */
	get running(): number {
		return this.#running;
	}

	/** Tasks waiting now. */
	get queued(): number {
		return this.#queue.length;
	}

	/** Whether a task given now would be refused: as many waiting as allowed. */
	get full(): boolean {
		return this.#running >= this.#max && this.#queue.length >= this.#maxQueued;
	}

	/** Runs `task` once a place is free; `undefined`, without running it, when the queue is full. */
	async run<T>(task: () => Promise<T>): Promise<{ value: T } | undefined> {
		if (this.#running >= this.#max) {
			if (this.#queue.length >= this.#maxQueued) return undefined;
			await new Promise<void>((resolve) => this.#queue.push(resolve));
		} else {
			this.#running++;
		}
		try {
			return { value: await task() };
		} finally {
			const next = this.#queue.shift();
			// The place passes to the next in line, or is freed.
			if (next === undefined) this.#running--;
			else next();
		}
	}
}
