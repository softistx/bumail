/** Why the server refused an option or a call. */
export type ImapErrorCode =
	| 'INVALID_OPTION'
	| 'ALREADY_LISTENING'
	| 'HOOK_TIMEOUT';

/**
 * Thrown by `createImapServer` and `listen` for a wrong option or call; and
 * what `onError` is given when `authenticate` does not settle in time.
 */
export class ImapError extends Error {
	override readonly name = 'ImapError';
	readonly code: ImapErrorCode;

	constructor(
		code: ImapErrorCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.code = code;
	}
}
