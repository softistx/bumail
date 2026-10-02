/** Why a message, a header or an encoding could not be read. */
export type MimeErrorCode =
	| 'HEADER_TOO_LARGE'
	| 'INVALID_ADDRESS'
	| 'INVALID_OPTION';

/** Thrown where a message breaks a limit or a value cannot be built. */
export class MimeError extends Error {
	override readonly name = 'MimeError';
	readonly code: MimeErrorCode;

	constructor(code: MimeErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
