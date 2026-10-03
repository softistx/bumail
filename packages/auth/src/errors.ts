/**
 * Why a call could not be made. Verifying never throws for a message: what
 * is wrong with one comes back as a result. These are thrown for what the
 * caller controls — an option, the message it asks to sign, a key.
 */
export type AuthErrorCode =
	| 'INVALID_OPTION'
	| 'INVALID_MESSAGE'
	| 'INVALID_KEY';

/** Thrown by `signDkim`, `importDkimPrivateKey`, and by `verifyDkim` for an option it cannot take. */
export class AuthError extends Error {
	override readonly name = 'AuthError';
	readonly code: AuthErrorCode;

	constructor(code: AuthErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
