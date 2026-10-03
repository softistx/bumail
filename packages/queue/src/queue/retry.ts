import type { RetrySettings } from './settings';

/**
 * The wait after the `attempts`-th attempt failed for now: `first`, then
 * `factor` times the wait before, at most `max`, plus up to `jitter` of
 * itself — never less, so RFC 5321 §4.5.4.1's 30 minutes stay a floor.
 */
export function retryDelay(
	attempts: number,
	retry: RetrySettings,
	random: () => number,
): number {
	const exponent = Math.max(0, attempts - 1);
	const delay = Math.min(retry.first * retry.factor ** exponent, retry.max);
	return delay + delay * retry.jitter * Math.min(1, Math.max(0, random()));
}

/** When a message's deferred recipients give up: `giveUpAfter` after it was enqueued. */
export const giveUpAt = (createdAt: number, retry: RetrySettings) =>
	createdAt + retry.giveUpAfter;

/**
 * The next attempt after the `attempts`-th, at `now`: the back-off, but no
 * later than the moment of giving up, so the last try falls on it.
 * `undefined` when that moment has come: what is still deferred fails.
 */
export function nextAttemptAt(
	createdAt: number,
	now: number,
	attempts: number,
	retry: RetrySettings,
	random: () => number,
): number | undefined {
	const end = giveUpAt(createdAt, retry);
	if (now >= end) return undefined;
	return Math.min(now + retryDelay(attempts, retry, random), end);
}
