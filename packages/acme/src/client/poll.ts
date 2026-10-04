import { AcmeError } from '../errors';
import { abortedError, sleep } from './failure';
import {
	type AcmeWaitOptions,
	DEFAULT_WAIT_TIMEOUT_MS,
	integerOption,
	MAX_POLL_DELAY_MS,
	MAX_WAIT_MS,
	signalOf,
} from './options';

/** What one poll found: the resource when it is done, or the CA's `Retry-After` and the state it is still in. */
export type PollStep<T> =
	| { done: T }
	| { after: number | undefined; state: string };

/**
 * Runs `step` until it returns `done`, sleeping between two runs as the
 * CA's `Retry-After` says, clamped from `intervalMs` to a minute, or
 * `intervalMs` when it says nothing; all within the options' `timeoutMs`
 * (`TIMEOUT`) and `signal` (`ABORTED`).
 */
export async function poll<T>(
	where: string,
	options: AcmeWaitOptions,
	intervalMs: number,
	step: (signal: AbortSignal) => Promise<PollStep<T>>,
): Promise<T> {
	const caller = signalOf(options, where);
	const timeoutMs = integerOption(
		options.timeoutMs,
		'timeoutMs',
		where,
		1,
		MAX_WAIT_MS,
		DEFAULT_WAIT_TIMEOUT_MS,
	);
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
	let state = 'unknown';
	const timedOut = (cause: unknown) =>
		new AcmeError('TIMEOUT', `${where}: still ${state} after ${timeoutMs} ms`, {
			cause,
		});
	for (;;) {
		let result: PollStep<T>;
		try {
			result = await step(signal);
		} catch (error) {
			if (deadline.aborted && !caller?.aborted) throw timedOut(error);
			throw error;
		}
		if ('done' in result) return result.done;
		state = result.state;
		try {
			await sleep(pollDelay(result.after, intervalMs), signal);
		} catch (error) {
			if (caller?.aborted) throw abortedError(where, caller);
			throw timedOut(error);
		}
	}
}

/** The wait before the next poll, in ms: `Retry-After` clamped from `intervalMs` to a minute. */
export function pollDelay(
	after: number | undefined,
	intervalMs: number,
): number {
	return after === undefined
		? intervalMs
		: Math.min(Math.max(after * 1000, intervalMs), MAX_POLL_DELAY_MS);
}
