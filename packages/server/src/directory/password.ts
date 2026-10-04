import { ServerError } from '../errors';

/** The shortest password a user may be given, in characters. */
export const MIN_PASSWORD_LENGTH = 12;
/**
 * The longest password, in bytes of UTF-8: well past any passphrase, and
 * short enough that hashing one costs what hashing any other does. Also
 * the longest login `authenticate` looks up, as `@bumail/store`'s
 * PostgreSQL store caps a login.
 */
export const MAX_PASSWORD_BYTES = 1024;

/** OWASP's argon2id floor: 19 MiB, two passes, one lane. */
export const HASH_OPTIONS = {
	algorithm: 'argon2id',
	memoryCost: 19456,
	timeCost: 2,
} as const;

/** Verifies running at once, by default; the rest wait their turn. */
export const DEFAULT_MAX_VERIFIES = 4;
/** Verifies waiting, by default; past it, `authenticate` answers `busy`. */
export const DEFAULT_MAX_QUEUED_VERIFIES = 1000;

const encoder = new TextEncoder();

/** The UTF-8 length of `text`. */
export function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/**
 * Refuses a password the directory does not keep: shorter than 12
 * characters, longer than 1024 bytes, or with a control character
 * (which no prompt types, and a file's trailing line break leaves).
 * The message never repeats the password.
 */
export function checkPassword(password: string): void {
	if (
		typeof password !== 'string' ||
		[...password].length < MIN_PASSWORD_LENGTH
	) {
		throw new ServerError(
			'INVALID',
			`the password must be at least ${MIN_PASSWORD_LENGTH} characters`,
		);
	}
	if (byteLength(password) > MAX_PASSWORD_BYTES) {
		throw new ServerError(
			'INVALID',
			`the password must be at most ${MAX_PASSWORD_BYTES} bytes`,
		);
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: what is refused
	if (/[\u0000-\u001f\u007f]/.test(password)) {
		throw new ServerError(
			'INVALID',
			'the password must not hold a control character, such as a line break',
		);
	}
}

/** The argon2id hash of `password`, as `Bun.password` encodes it. */
export function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, HASH_OPTIONS);
}

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
