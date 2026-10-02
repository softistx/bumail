import { hasControl } from '../encoding/bytes';
import { MimeError } from '../errors';
import { ADDRESS_SPECIALS, tokenize } from './tokens';

/** RFC 5322 §3.2.3's atext, with RFC 6532's non-ASCII. */
const ATEXT = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\u0080-\\u{10FFFF}]";
const DOT_ATOM = new RegExp(`^${ATEXT}+(?:\\.${ATEXT}+)*$`, 'u');
/** A quoted-string local part (§3.2.4): printable ASCII and spaces, `"` and `\\` escaped. */
const QUOTED =
	/^"(?:[\x20\x21\x23-\x5b\x5d-\x7e\u0080-\u{10FFFF}]|\\[\x20-\x7e])*"$/u;
/**
 * A domain: dot-separated labels, or an address literal in brackets — IPv4,
 * `IPv6:…`, or `tag:content` (RFC 5321 §4.1.3), with no `<`, `>`, `,` or
 * `"` that would end an SMTP path or add a recipient.
 */
const DOMAIN =
	/^(?:[A-Za-z0-9_\u0080-\u{10FFFF}](?:[A-Za-z0-9_\-\u0080-\u{10FFFF}]*[A-Za-z0-9_\u0080-\u{10FFFF}])?(?:\.[A-Za-z0-9_\u0080-\u{10FFFF}](?:[A-Za-z0-9_\-\u0080-\u{10FFFF}]*[A-Za-z0-9_\u0080-\u{10FFFF}])?)*|\[(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|IPv6:[0-9A-Fa-f:.]+|[A-Za-z0-9-]*[A-Za-z0-9]:[\x21\x23-\x2b\x2d-\x3b\x3d\x3f-\x5a\x5e-\x7e]+)\])$/u;

/**
 * Whether text holds a character that shows nothing or reorders what it
 * shows: C1 controls, zero-width characters, line and paragraph
 * separators, bidirectional overrides and isolates. Each lets an address
 * pass for another.
 */
function hasInvisible(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (
			(code >= 0x80 && code <= 0x9f) ||
			(code >= 0x200b && code <= 0x200f) ||
			(code >= 0x2028 && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Whether an address list holds text after a mailbox's `<addr>` other than
 * white space or a comment: `A <a@b.c> B <v@x.y>` or `<a@b.c> v@x.y`, which
 * a lenient reader would cut to the first address.
 */
export function hasStrayText(value: string): boolean {
	let inAngle = false;
	let closed = false;
	for (const token of tokenize(value, ADDRESS_SPECIALS)) {
		if (token.kind === 'space' || token.kind === 'comment') continue;
		if (
			token.kind === 'special' &&
			!inAngle &&
			[',', ';', ':'].includes(token.value)
		) {
			closed = false;
			continue;
		}
		if (closed) return true;
		if (token.kind === 'special' && token.value === '<') inAngle = true;
		if (token.kind === 'special' && token.value === '>') {
			inAngle = false;
			closed = true;
		}
	}
	return false;
}

/**
 * Throws unless `address` can go into a header or an SMTP command as it is:
 * a dot-atom or quoted-string local part, an `@`, and a domain or an
 * address literal (RFC 5322 §3.4.1). Nothing else gets through: no comma
 * that would add a recipient, no bracket, comment, quote or line break.
 */
export function checkAddress(address: string, caller: string): string {
	const at = address.lastIndexOf('@');
	const local = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (
		at <= 0 ||
		hasControl(address) ||
		hasInvisible(address) ||
		!(DOT_ATOM.test(local) || QUOTED.test(local)) ||
		!DOMAIN.test(domain)
	) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`${caller}: "${JSON.stringify(address).slice(1, -1)}" is not an e-mail address`,
		);
	}
	return address;
}
