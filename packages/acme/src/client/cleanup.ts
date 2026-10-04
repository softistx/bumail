import { AcmeError } from '../errors';
import { abortedError } from './failure';

/** The flow's failure, and the cleanup's after it: the first is thrown, the second its `cause`. */
export class Uncleaned {
	constructor(
		readonly error: unknown,
		readonly cleanup: unknown,
	) {}
}

/** `error` again, its code, message and problem kept, with `cleanup` as its `cause`. */
export function withCleanup(error: AcmeError, cleanup: unknown): AcmeError {
	if (cleanup === undefined) return error;
	return new AcmeError(error.code, error.message, {
		cause: cleanup,
		...(error.problem === undefined ? {} : { problem: error.problem }),
		...(error.status === undefined ? {} : { status: error.status }),
		...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
	});
}

/** Where `obtainCertificate` stood when its flow threw. */
export interface FlowEnd {
	where: string;
	caller: AbortSignal | undefined;
	deadline: AbortSignal;
	timeoutMs: number;
}

/**
 * What `obtainCertificate` throws for what its flow threw: `ABORTED` (or
 * `TIMEOUT` for an `AbortSignal.timeout`) when the caller's signal fired,
 * `TIMEOUT` past `timeoutMs`, the flow's error otherwise. A cleanup
 * failure becomes the `cause` of the first two, and of an `AcmeError`
 * with no cause of its own; it is dropped otherwise.
 */
export function flowError(thrown: unknown, end: FlowEnd): unknown {
	const { error, cleanup } =
		thrown instanceof Uncleaned
			? thrown
			: { error: thrown, cleanup: undefined };
	if (end.caller?.aborted) {
		return withCleanup(abortedError(end.where, end.caller), cleanup);
	}
	if (end.deadline.aborted) {
		return new AcmeError(
			'TIMEOUT',
			`${end.where}: no certificate within ${end.timeoutMs} ms`,
			{ cause: cleanup ?? error },
		);
	}
	if (
		cleanup !== undefined &&
		error instanceof AcmeError &&
		error.cause === undefined
	) {
		return withCleanup(error, cleanup);
	}
	return error;
}
