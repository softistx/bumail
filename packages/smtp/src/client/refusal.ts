import { SmtpError } from '../errors';
import type { Reply } from '../protocol/reply';
import { replyText } from '../protocol/reply-reader';

/** A reply as an error message shows it: code, status, text, cut at 200 characters. */
export function shown(reply: Reply): string {
	const text = replyText(reply);
	const line = `${reply.code}${reply.status ? ` ${reply.status}` : ''} ${text}`;
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** `REFUSED`, temporary for a 4xx: the server said no to `what`. */
export function refused(host: string, what: string, reply: Reply): SmtpError {
	return new SmtpError('REFUSED', `${host} refused ${what}: ${shown(reply)}`, {
		reply,
	});
}

/** `BAD_REPLY`: what the server sent is not a reply, or too much of one. */
export const badReply = (host: string, what: string) =>
	new SmtpError('BAD_REPLY', `${host} sent ${what}`);

/** `CONNECTION_LOST` while waiting for `what`, or while the message was sent. */
export const lost = (host: string, what?: string) =>
	new SmtpError(
		'CONNECTION_LOST',
		what === undefined
			? `The connection to ${host} closed while the message was sent`
			: `The connection to ${host} closed before ${what}`,
	);

/** `TIMEOUT`: a step's own, or the whole delivery's deadline when `deadline` is given. */
export const timedOut = (
	host: string,
	what: string,
	seconds: number,
	deadline?: number,
) =>
	new SmtpError(
		'TIMEOUT',
		deadline === undefined
			? `Timed out after ${seconds} s waiting for ${what} (${host})`
			: `The deadline of ${deadline} s passed waiting for ${what} (${host})`,
	);

/** `TLS_FAILED`: the handshake, or the certificate's check. */
export const tlsFailed = (host: string, why: string) =>
	new SmtpError('TLS_FAILED', `TLS with ${host} failed: ${why}`);
