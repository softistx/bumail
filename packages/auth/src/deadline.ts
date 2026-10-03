/**
 * The `timeout` option `checkSpf` and `checkDmarc` share: how it is
 * checked, and how a lookup is raced against it.
 */

/** The longest `setTimeout` delay: a longer one fires at once (2^31 − 1 ms, about 24.8 days). */
export const MAX_TIMEOUT = 2_147_483_647;

/** What is wrong with a `timeout` option, or `undefined` when it is left out or fine. */
export function timeoutProblem(timeout: unknown): string | undefined {
	if (timeout === undefined) return undefined;
	if (!(Number.isSafeInteger(timeout) && (timeout as number) > 0)) {
		return `timeout must be a positive integer of milliseconds, not ${String(timeout)}`;
	}
	if ((timeout as number) > MAX_TIMEOUT) {
		return `timeout must be at most ${MAX_TIMEOUT} ms, not ${timeout}`;
	}
	return undefined;
}

/**
 * `promise`, unless `deadline` (in `performance.now()` milliseconds)
 * comes first: then what `late()` returns is thrown. The timer never
 * outlives the race, and never waits longer than `MAX_TIMEOUT`.
 */
export async function beforeDeadline<T>(
	promise: Promise<T>,
	deadline: number,
	late: () => unknown,
): Promise<T> {
	const left = Math.min(deadline - performance.now(), MAX_TIMEOUT);
	if (left <= 0) throw late();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(late()), left);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
