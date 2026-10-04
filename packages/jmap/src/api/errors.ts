/** A method-level error type (RFC 8620 §3.6.2, §5; RFC 8621). */
export type MethodErrorType =
	| 'serverUnavailable'
	| 'serverFail'
	| 'serverPartialFail'
	| 'unknownMethod'
	| 'invalidArguments'
	| 'invalidResultReference'
	| 'forbidden'
	| 'accountNotFound'
	| 'accountNotSupportedByMethod'
	| 'accountReadOnly'
	| 'requestTooLarge'
	| 'cannotCalculateChanges'
	| 'stateMismatch'
	| 'anchorNotFound'
	| 'unsupportedSort'
	| 'unsupportedFilter'
	| 'tooManyChanges';

/** Thrown inside a method: answered as an `error` response for its call. */
export class MethodError extends Error {
	override readonly name = 'MethodError';
	readonly type: MethodErrorType;
	readonly extra: Readonly<Record<string, unknown>>;

	constructor(
		type: MethodErrorType,
		description?: string,
		extra: Record<string, unknown> = {},
	) {
		super(description ?? type);
		this.type = type;
		this.extra = extra;
	}

	/** The arguments of the `error` response. */
	toJSON(): Record<string, unknown> {
		return {
			type: this.type,
			...(this.message === this.type ? {} : { description: this.message }),
			...this.extra,
		};
	}
}

export const invalidArguments = (description: string) =>
	new MethodError('invalidArguments', description);

/** A SetError (RFC 8620 §5.3): why one object was not created, updated or destroyed. */
export interface SetError {
	readonly type: string;
	readonly description?: string;
	readonly properties?: readonly string[];
	readonly [key: string]: unknown;
}

export function setError(
	type: string,
	description?: string,
	properties?: readonly string[],
): SetError {
	return {
		type,
		...(description === undefined ? {} : { description }),
		...(properties === undefined ? {} : { properties }),
	};
}
