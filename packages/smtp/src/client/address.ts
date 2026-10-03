import { parsePath } from '../protocol/path';

/**
 * Whether `address` is an RFC 5321 Mailbox (§4.1.2), with no source
 * route: `local@domain`, a dot-string or quoted local part of 64
 * characters at most and a domain of valid labels, or an address literal,
 * with no brackets. Every such address is one `sendMail` takes as a
 * recipient, or as a sender other than the null one; `sendMail` also takes
 * a path with a source route, which this refuses. A caller that keeps
 * addresses for later, such as a queue, checks them with this when it
 * takes them, so `sendMail` never refuses them with `INVALID_OPTION`
 * afterwards.
 */
export function isMailbox(address: unknown): address is string {
	return (
		typeof address === 'string' &&
		!address.startsWith('@') &&
		parsePath(`<${address}>`, false) !== undefined
	);
}
