import { isIP } from 'node:net';
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
 * labels or more. `Bücher.Example.` is `xn--bcher-kva.example`. An IP
 * address, a percent-escape (which `domainToASCII` would decode) and a
 * last label of digits or `0x…` hex are refused.
 */
export function domainOf(name: string): string | undefined {
	if (typeof name !== 'string' || /[\s@%]/.test(name)) return undefined;
	const bare = name.replace(/\.$/, '');
	if (isIP(bare.replace(/^\[|\]$/g, '')) !== 0) return undefined;
	const ascii = domainToASCII(bare);
	if (ascii === '' || !isDomainName(ascii)) return undefined;
	// A last label of digits or hex (`0x7f`) is how WHATWG URL reads an
	// IPv4 address (`1.2.3.4`, `example.0x7f`), never a top-level domain.
	const last = ascii.slice(ascii.lastIndexOf('.') + 1);
	return /^(?:\d+|0x[0-9a-f]*)$/.test(last) ? undefined : ascii;
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
	// NFC again after lowercasing, which can leave a decomposed pair
	// (`T̈` → `t` + U+0308, which NFC composes to `ẗ`): a fixed point, so
	// the address kept is read back as itself.
	const local = text
		.slice(0, at)
		.normalize('NFC')
		.toLowerCase()
		.normalize('NFC');
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

/**
 * What was given, quoted, cut to 80 characters with its controls
 * escaped, for a message — when it holds an `@` or a `.`, as an address
 * or a domain mistyped does. Anything else may be a password typed in
 * the wrong place, and is not repeated: it is `the value given`.
 */
export function shown(text: string): string {
	const value = String(text);
	if (!/[@.]/.test(value)) return 'the value given';
	const cut = value.length > 80 ? `${value.slice(0, 80)}…` : value;
	return JSON.stringify(cut);
}
