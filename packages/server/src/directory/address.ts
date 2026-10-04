import { domainToASCII } from 'node:url';
import { isDomainName } from '../config/names';
import { ServerError } from '../errors';

/** RFC 5321 §4.5.3.1.1: a local part is 64 octets at most. */
export const MAX_LOCAL_BYTES = 64;
/** RFC 5321 §4.5.3.1.3 caps a path at 256 octets, its brackets included: 254 for the address. */
export const MAX_ADDRESS_BYTES = 254;

/**
 * A dot-atom (RFC 5322 §3.2.3): atoms of `atext`, or of any character
 * past ASCII (RFC 6532 §3.2, for SMTPUTF8), joined by single dots. No
 * quoted string: nothing a user types needs one, and it would give one
 * mailbox several spellings.
 */
const DOT_ATOM =
	/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-\u{10FFFF}]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-\u{10FFFF}]+)*$/u;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** An address as the directory keeps it: `local@domain`, both lowercase. */
export interface Address {
	readonly address: string;
	readonly local: string;
	readonly domain: string;
}

/**
 * A domain as the directory keeps it — lowercase, in A-labels, without a
 * trailing dot — or `undefined` when it is not a domain name of two
 * labels or more. `Bücher.Example.` is `xn--bcher-kva.example`.
 */
export function domainOf(name: string): string | undefined {
	if (typeof name !== 'string' || /[\s@]/.test(name)) return undefined;
	const ascii = domainToASCII(name.replace(/\.$/, ''));
	return ascii !== '' && isDomainName(ascii) ? ascii : undefined;
}

/**
 * An address as the directory keeps it, or `undefined` when it is not
 * one: a dot-atom local part of 64 octets at most, `@`, a domain name.
 *
 * **Case.** The domain is lowercased, as DNS compares it. So is the local
 * part — after Unicode NFC, so one name typed two ways is one mailbox:
 * RFC 5321 §2.4 lets the server that hosts a mailbox decide whether case
 * matters in its local parts, and here it does not. `Alice@Example.COM`
 * and `alice@example.com` are the same user, and no two users or aliases
 * differ by case alone.
 */
export function addressOf(text: string): Address | undefined {
	if (typeof text !== 'string') return undefined;
	const at = text.lastIndexOf('@');
	if (at < 1) return undefined;
	const local = text.slice(0, at).normalize('NFC').toLowerCase();
	const domain = domainOf(text.slice(at + 1));
	if (
		domain === undefined ||
		!DOT_ATOM.test(local) ||
		bytes(local) > MAX_LOCAL_BYTES
	) {
		return undefined;
	}
	const address = `${local}@${domain}`;
	return bytes(address) > MAX_ADDRESS_BYTES
		? undefined
		: { address, local, domain };
}

/** `domainOf`, or `ServerError('INVALID')`. */
export function checkDomain(name: string): string {
	const domain = domainOf(name);
	if (domain === undefined) {
		throw new ServerError('INVALID', `${shown(name)} is not a domain name`);
	}
	return domain;
}

/** `addressOf`, or `ServerError('INVALID')`. */
export function checkAddress(text: string): Address {
	const address = addressOf(text);
	if (address === undefined) {
		throw new ServerError('INVALID', `${shown(text)} is not an e-mail address`);
	}
	return address;
}

/** What was given, quoted and cut to 80 characters with its controls escaped, for a message. */
export function shown(text: string): string {
	const value = String(text);
	const cut = value.length > 80 ? `${value.slice(0, 80)}…` : value;
	return JSON.stringify(cut);
}
