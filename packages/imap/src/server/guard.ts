import { ImapError } from '../errors';
import type { Connection } from './connection';

const TIMED_OUT = Symbol('timed out');

/** `promise`, or `TIMED_OUT` once `seconds` have passed. */
async function within<T>(
	promise: Promise<T>,
	seconds: number,
): Promise<T | typeof TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), seconds * 1000);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Runs app code that answers a value, within `hookTimeout`: `failed` when
 * it threw or timed out, which is reported to `onError`.
 */
export async function guarded<T>(
	connection: Connection,
	name: string,
	run: () => T | Promise<T>,
): Promise<{ failed: false; value: T } | { failed: true }> {
	const seconds = connection.settings.hookTimeout;
	try {
		const value = await within(Promise.resolve().then(run), seconds);
		if (value === TIMED_OUT) {
			connection.report(
				new ImapError(
					'HOOK_TIMEOUT',
					`${name} did not settle within hookTimeout (${seconds} s)`,
				),
			);
			return { failed: true };
		}
		return { failed: false, value };
	} catch (error) {
		connection.report(error);
		return { failed: true };
	}
}
