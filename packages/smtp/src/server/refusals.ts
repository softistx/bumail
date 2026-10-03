import { SmtpError } from '../errors';
import { reply } from '../protocol/reply';

/** Why a message on its way in is refused, as the reply and the error `onData` and `onError` see. */

export const TOO_BIG = reply(552, '5.3.4', 'Message too big for system');

export const BARE_LINE_BREAK = reply(
	550,
	'5.6.11',
	'Bare CR or LF is not allowed in a message',
);

export function tooBig(maxMessageSize: number): SmtpError {
	return new SmtpError(
		'MESSAGE_TOO_BIG',
		`The message is larger than maxMessageSize (${maxMessageSize} bytes); do not deliver it`,
	);
}

/** A bare CR or LF is how SMTP smuggling hides a second message. */
export function bareLineBreak(): SmtpError {
	return new SmtpError(
		'BARE_LINE_BREAK',
		'The message holds a bare CR or LF (SMTP smuggling); do not deliver it',
	);
}

/** The client left mid-message, or after its end but before the reply. */
export function connectionLost(ended: boolean): SmtpError {
	return new SmtpError(
		'CONNECTION_LOST',
		ended
			? 'The client disconnected before the reply to the message; do not deliver it'
			: 'The client disconnected before the end of the message; do not deliver it',
	);
}

export function notAnswered(seconds: number): SmtpError {
	return new SmtpError(
		'HOOK_TIMEOUT',
		`onData did not answer within hookTimeout (${seconds} s); do not deliver it`,
	);
}

export function notReadInTime(seconds: number): SmtpError {
	return new SmtpError(
		'HOOK_TIMEOUT',
		`onData did not read the message within hookTimeout (${seconds} s); do not deliver it`,
	);
}

export function notRead(): SmtpError {
	return new SmtpError(
		'MESSAGE_NOT_READ',
		'onData answered without reading the message to its end; it was not taken',
	);
}
