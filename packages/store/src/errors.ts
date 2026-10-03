/**
 * Why a store refused an operation. `CANNOT_CALCULATE_CHANGES` means a
 * `since` older than what the store still remembers: the client starts
 * over (JMAP's `cannotCalculateChanges`, QRESYNC's full resync).
 */
export type StoreErrorCode =
	| 'NOT_FOUND'
	| 'ALREADY_EXISTS'
	| 'INVALID'
	| 'CANNOT_CALCULATE_CHANGES';

/** Thrown by every store, whichever answers the contract, with the same codes. */
export class StoreError extends Error {
	override readonly name = 'StoreError';
	readonly code: StoreErrorCode;

	constructor(code: StoreErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
