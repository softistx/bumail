import {
	type Reply,
	type SendMailResult,
	SmtpError,
	type SmtpErrorCode,
} from '@bumail/smtp/client';
import type { Diagnostic, RecipientUpdate } from '../contract/types';
import { cleanText } from '../text';

/** An enhanced status code, `x.y.z` (RFC 3463 §2). */
const STATUS = /^[245]\.\d{1,3}\.\d{1,3}$/;

/** What a reply says, bounded and cleaned. */
export function diagnosticOf(
	reply: Reply,
	max: number,
	host?: string,
): Diagnostic {
	const text =
		typeof reply.text === 'string' ? reply.text : reply.text.join(' ');
	return {
		code: reply.code,
		...(reply.status && STATUS.test(reply.status)
			? { status: reply.status }
			: {}),
		text: cleanText(text, max),
		...(host ? { host: cleanText(host, 255) } : {}),
	};
}

/**
 * The status code an error with no reply stands for (RFC 3463 §3): a null
 * MX is X.1.10 (RFC 7505 §4.2), a domain that cannot be found X.1.2, a
 * host that does not answer X.4.1, a connection lost or timed out X.4.2,
 * TLS X.7.0 (security).
 */
const ERROR_STATUS: Partial<Record<SmtpErrorCode, string>> = {
	NULL_MX: '1.10',
	DNS_FAILED: '1.2',
	CONNECTION_FAILED: '4.1',
	CONNECTION_LOST: '4.2',
	TIMEOUT: '4.2',
	TLS_UNAVAILABLE: '7.10',
	TLS_FAILED: '7.0',
	AUTH_UNAVAILABLE: '7.0',
};

/** A failure that never got a reply: an error of the network, the DNS, TLS, or anything else. */
function diagnosticOfError(
	error: unknown,
	temporary: boolean,
	max: number,
	host?: string,
): Diagnostic {
	const text = error instanceof Error ? error.message : String(error);
	const detail =
		error instanceof SmtpError ? (ERROR_STATUS[error.code] ?? '0.0') : '0.0';
	return {
		status: `${temporary ? 4 : 5}.${detail}`,
		text: cleanText(text, max),
		...(host ? { host } : {}),
	};
}

/** Each recipient of a delivery `sendMail` resolved: taken, or refused one by one. */
export function outcomesOf(
	result: SendMailResult,
	group: readonly string[],
	max: number,
): RecipientUpdate[] {
	const host = result.host;
	const updates = new Map<string, RecipientUpdate>();
	for (const { recipient } of result.accepted) {
		updates.set(recipient, {
			address: recipient,
			status: 'delivered',
			reply: diagnosticOf(result.reply, max, host),
		});
	}
	for (const { recipient, reply } of result.rejected) {
		updates.set(recipient, {
			address: recipient,
			status: reply.code >= 500 ? 'failed' : 'deferred',
			reply: diagnosticOf(reply, max, host),
		});
	}
	// sendMail names every recipient it was given; a fake may not.
	return group.map(
		(address) =>
			updates.get(address) ?? {
				address,
				status: 'deferred',
				reply: { text: 'The delivery said nothing of this recipient', host },
			},
	);
}

/**
 * Each recipient of a delivery `sendMail` rejected: by its own reply when
 * the server refused every one, else all alike — deferred when the error
 * is temporary (a 4xx, the network, a timeout), failed otherwise.
 */
export function outcomesOfError(
	error: unknown,
	group: readonly string[],
	max: number,
	host?: string,
): RecipientUpdate[] {
	const rejected = new Map(
		error instanceof SmtpError
			? (error.rejected ?? []).map((r) => [r.recipient, r.reply])
			: [],
	);
	const temporary = !(error instanceof SmtpError) || error.temporary;
	return group.map((address): RecipientUpdate => {
		const own = rejected.get(address);
		if (own) {
			return {
				address,
				status: own.code >= 500 ? 'failed' : 'deferred',
				reply: diagnosticOf(own, max, host),
			};
		}
		const reply =
			error instanceof SmtpError && error.reply
				? diagnosticOf(error.reply, max, host)
				: diagnosticOfError(error, temporary, max, host);
		return { address, status: temporary ? 'deferred' : 'failed', reply };
	});
}
