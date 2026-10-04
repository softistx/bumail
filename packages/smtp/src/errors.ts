import type { Reply } from './protocol/reply';

/** Why the server refused an option, why a message stream ended in error, or why `sendMail` failed. */
export type SmtpErrorCode =
	| 'INVALID_OPTION'
	| 'ALREADY_LISTENING'
	| 'STOPPED'
	| 'MESSAGE_TOO_BIG'
	| 'BARE_LINE_BREAK'
	| 'CONNECTION_LOST'
	| 'HOOK_TIMEOUT'
	| 'INVALID_HOOK_REPLY'
	| 'MESSAGE_NOT_READ'
	| 'CONNECTION_FAILED'
	| 'TIMEOUT'
	| 'BAD_REPLY'
	| 'REFUSED'
	| 'RECIPIENTS_REFUSED'
	| 'TLS_UNAVAILABLE'
	| 'TLS_FAILED'
	| 'AUTH_UNAVAILABLE'
	| 'EXTENSION_MISSING'
	| 'NULL_MX'
	| 'DNS_FAILED';

/** One recipient and the server's reply to its `RCPT TO`. */
export interface RecipientReply {
	readonly recipient: string;
	readonly reply: Reply;
}

/** What `sendMail` adds to an error: whether to try again, and the reply behind it. */
export interface SmtpErrorDetails {
	/** Trying again later may succeed: a 4xx, the network, a timeout. */
	readonly temporary?: boolean;
	/** The server's reply that failed the delivery, enhanced status code included. */
	readonly reply?: Reply;
	/** With `RECIPIENTS_REFUSED`: each recipient, and why it was refused. */
	readonly rejected?: readonly RecipientReply[];
	/** The error behind this one, as `Error`'s `cause`. */
	readonly cause?: unknown;
}

/** The codes that are temporary unless a reply or `details` says otherwise. */
const TEMPORARY = new Set<SmtpErrorCode>([
	'CONNECTION_LOST',
	'CONNECTION_FAILED',
	'TIMEOUT',
	'BAD_REPLY',
	'TLS_UNAVAILABLE',
	'TLS_FAILED',
]);

/**
 * Thrown by `createSmtpServer` and `listen` for a wrong option or call; the
 * error a message's `content` stream ends with when the message must not be
 * delivered; what `onError` is given for a hook that broke a rule; and what
 * `sendMail` rejects with. `temporary` tells a failure worth trying again
 * later (a 4xx, the network, a timeout) from a permanent one (a 5xx, a null
 * MX, a message the server can never take).
 */
export class SmtpError extends Error {
	override readonly name = 'SmtpError';
	readonly code: SmtpErrorCode;
	/** Trying again later may succeed. Meaningful for `sendMail`'s errors. */
	readonly temporary: boolean;
	/** The server reply behind a `sendMail` failure, enhanced status code included. */
	readonly reply?: Reply;
	/** With `RECIPIENTS_REFUSED`: each recipient, and the reply that refused it. */
	readonly rejected?: readonly RecipientReply[];

	constructor(
		code: SmtpErrorCode,
		message: string,
		details: SmtpErrorDetails = {},
	) {
		super(
			message,
			details.cause === undefined ? undefined : { cause: details.cause },
		);
		this.code = code;
		this.temporary =
			details.temporary ??
			(details.reply ? details.reply.code < 500 : TEMPORARY.has(code));
		if (details.reply) this.reply = details.reply;
		if (details.rejected) this.rejected = details.rejected;
	}
}
