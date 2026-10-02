import { SmtpError } from '../errors';
import { type Reply, reply } from '../protocol/reply';

/** The reply when a hook throws, times out or answers what is not a refusal. */
export const LOCAL_ERROR = reply(451, '4.3.0', 'Local error in processing');

const TIMED_OUT = Symbol('timed out');

/** `promise`, or `TIMED_OUT` once `seconds` have passed. */
export async function within<T>(
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

export function timedOut(value: unknown): value is typeof TIMED_OUT {
	return value === TIMED_OUT;
}

export function hookTimeout(name: string, seconds: number): SmtpError {
	return new SmtpError(
		'HOOK_TIMEOUT',
		`${name} did not settle within hookTimeout (${seconds} s)`,
	);
}

/**
 * What a hook answered, as the reply to send: `undefined` to go on, or the
 * refusal. A reply under 400 is not a refusal — sending it would tell the
 * client yes while the server did not take the command — so it is reported
 * and answered as a local error.
 */
export function refusalOf(
	name: string,
	answer: unknown,
	report: (error: unknown) => void,
): Reply | undefined {
	if (answer === undefined) return undefined;
	const code = (answer as Partial<Reply> | null)?.code;
	if (typeof code === 'number' && code >= 400 && code < 600) {
		return answer as Reply;
	}
	report(
		new SmtpError(
			'INVALID_HOOK_REPLY',
			`${name} answered ${JSON.stringify(answer)}, which is not a refusal: a hook refuses with a 4xx or 5xx reply, and accepts with undefined`,
		),
	);
	return LOCAL_ERROR;
}
