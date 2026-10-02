/** Why a store refused an operation. */
export type StoreErrorCode = 'NOT_FOUND' | 'ALREADY_EXISTS' | 'INVALID';

/** Thrown by every store, whichever answers the contract, with the same codes. */
export class StoreError extends Error {
	override readonly name = 'StoreError';
	readonly code: StoreErrorCode;

	constructor(code: StoreErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
