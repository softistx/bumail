import { AcmeError } from '../errors';
import { printable } from './problem';

/**
 * The `AcmeError` for a request that ended without an answer: the
 * caller's signal first (`abortedError`), then the request's own time
 * limit (`TIMEOUT`), else `NETWORK_ERROR`.
 */
export function failureOf(
	where: string,
	error: unknown,
	caller: AbortSignal | undefined,
	limit: { signal: AbortSignal; ms: number } | undefined,
): AcmeError {
	if (error instanceof AcmeError) return error;
	if (caller?.aborted) return abortedError(where, caller);
	if (limit?.signal.aborted) {
		return new AcmeError(
			'TIMEOUT',
			`${where}: no answer within ${limit.ms} ms`,
			{ cause: error },
		);
	}
	return new AcmeError(
		'NETWORK_ERROR',
		`${where}: fetch failed: ${printable(error instanceof Error ? error.message : String(error), 200)}`,
		{ cause: error },
	);
}

/**
 * The `AcmeError` for the caller's signal having fired: `TIMEOUT` when its
 * reason is a timeout (`AbortSignal.timeout`), `ABORTED` otherwise, the
 * reason kept as the cause.
 */
export function abortedError(where: string, signal: AbortSignal): AcmeError {
	const reason: unknown = signal.reason;
	if (reason instanceof DOMException && reason.name === 'TimeoutError') {
		return new AcmeError('TIMEOUT', `${where}: the signal timed out`, {
			cause: reason,
		});
	}
	return new AcmeError('ABORTED', `${where}: aborted`, { cause: reason });
}

/** Waits `ms`, or rejects with `signal`'s reason as soon as it fires. */
export function sleep(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const done = () => {
			signal?.removeEventListener('abort', aborted);
			resolve();
		};
		const timer = setTimeout(done, ms);
		const aborted = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener('abort', aborted, { once: true });
	});
}

/**
 * `promise`, or a rejection with `signal`'s reason as soon as it fires: a
 * caller's hook that never settles cannot hold a bounded flow.
 */
export function untilAborted<T>(
	promise: Promise<T> | T,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener('abort', aborted, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				signal.removeEventListener('abort', aborted);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', aborted);
				reject(error);
			},
		);
	});
}
