import { parsePath } from '../protocol/path';

/**
 * Whether `address` is one `sendMail` takes as a recipient, or as a sender
 * other than the null one: exactly those, since `sendMail` checks its
 * addresses with this same predicate. That is an RFC 5321 Mailbox
 * (§4.1.2), `local@domain` with no brackets — a dot-string or quoted local
 * part of 64 characters at most, and a domain of valid labels or an
 * address literal — with no source route, no control character (C0, DEL,
 * C1), no `>`, no Unicode format character and no lone surrogate, and an
 * IPv4 literal's octets at most 255. A caller that keeps addresses for
 * later, such as a queue, checks them with this when it takes them, so
 * `sendMail` never refuses them with `INVALID_OPTION` afterwards.
 */
export function isMailbox(address: unknown): address is string {
	return (
		typeof address === 'string' &&
		parsePath(`<${address}>`, false, 'refuse') !== undefined
	);
}
