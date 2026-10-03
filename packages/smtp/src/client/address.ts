import { parsePath } from '../protocol/path';

/**
 * Whether `sendMail` takes `address` as a recipient, or as a sender other
 * than the null one: `local@domain` by RFC 5321's grammar (§4.1.2), a
 * dot-string or quoted local part of 64 characters at most and a domain
 * of valid labels, or an address literal — with no brackets and no source
 * route. A caller that keeps addresses for later, such as a queue, checks
 * them with this when it takes them, so `sendMail` never refuses them
 * with `INVALID_OPTION` afterwards.
 */
export function isMailbox(address: unknown): address is string {
	return (
		typeof address === 'string' &&
		!address.startsWith('@') &&
		parsePath(`<${address}>`, false) !== undefined
	);
}
