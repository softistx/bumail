/**
 * Why the queue or a store refused a call. `INVALID`: an option or an
 * argument it cannot take. `MESSAGE_TOO_BIG`, `TOO_MANY_RECIPIENTS` and
 * `QUEUE_FULL`: a limit `enqueue` enforces. `CLOSED`: a store used after
 * `close()`. `LEASE_LOST`: given to the `error` event when another worker
 * took an item before its outcome was recorded — or, once the lease's
 * expiry passed, when the item is gone: lost or cancelled.
 * `MESSAGE_UNREADABLE`: given to the `error` event when the store holds an
 * item but not its message, whose pending recipients then fail.
 */
export type QueueErrorCode =
	| 'INVALID'
	| 'MESSAGE_TOO_BIG'
	| 'TOO_MANY_RECIPIENTS'
	| 'QUEUE_FULL'
	| 'CLOSED'
	| 'LEASE_LOST'
	| 'MESSAGE_UNREADABLE';

/** Thrown by the queue and by every store, whichever answers the contract, with the same codes. */
export class QueueError extends Error {
	override readonly name = 'QueueError';
	readonly code: QueueErrorCode;

	constructor(code: QueueErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** `INVALID`, for an option or an argument. */
export const invalid = (message: string) => new QueueError('INVALID', message);
