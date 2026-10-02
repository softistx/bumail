/** Why the server refused an option, or why a message stream ended in error. */
export type SmtpErrorCode =
	| 'INVALID_OPTION'
	| 'ALREADY_LISTENING'
	| 'MESSAGE_TOO_BIG'
	| 'BARE_LINE_BREAK'
	| 'CONNECTION_LOST'
	| 'HOOK_TIMEOUT'
	| 'INVALID_HOOK_REPLY';

/**
 * Thrown by `createSmtpServer` and `listen` for a wrong option or call; the
 * error a message's `content` stream ends with when the message must not be
 * delivered; and what `onError` is given for a hook that broke a rule.
 */
export class SmtpError extends Error {
	override readonly name = 'SmtpError';
	readonly code: SmtpErrorCode;

	constructor(code: SmtpErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
