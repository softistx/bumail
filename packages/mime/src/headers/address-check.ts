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
 * `"` that would end an SMTP path or add a recipient. An `IPv6:` literal is
 * checked for its characters, not parsed as an address: what matters here
 * is that nothing in it can break out of a header or a path.
 */
const DOMAIN =
	/^(?:[A-Za-z0-9_\u0080-\u{10FFFF}](?:[A-Za-z0-9_\-\u0080-\u{10FFFF}]*[A-Za-z0-9_\u0080-\u{10FFFF}])?(?:\.[A-Za-z0-9_\u0080-\u{10FFFF}](?:[A-Za-z0-9_\-\u0080-\u{10FFFF}]*[A-Za-z0-9_\u0080-\u{10FFFF}])?)*|\[(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|IPv6:[0-9A-Fa-f:.]+|[A-Za-z0-9-]*[A-Za-z0-9]:[\x21\x23-\x2b\x2d-\x3b\x3d\x3f-\x5a\x5e-\x7e]+)\])$/u;

/**
 * A character that shows nothing or reorders what it shows: C1 controls,
 * every format character (Unicode's Cf: zero-width and joiners, soft
 * hyphen, bidirectional marks, overrides and isolates, the BOM), and the
 * line and paragraph separators. Each lets an address pass for another.
 */
const INVISIBLE = /[\u0080-\u009f\p{Cf}\u2028\u2029]/u;
const INVISIBLE_ALL = /[\u0080-\u009f\p{Cf}\u2028\u2029]/gu;

/** The value for an error message: controls and invisible characters shown as escapes. */
export function shown(value: string): string {
	return JSON.stringify(value)
		.slice(1, -1)
		.replace(INVISIBLE_ALL, (char) => {
			const code = char.codePointAt(0) ?? 0;
			return code > 0xffff
				? `\\u{${code.toString(16)}}`
				: `\\u${code.toString(16).padStart(4, '0')}`;
		});
}

/**
 * Whether an address list holds text a reader would drop or misread: after
 * a mailbox's `<addr>` (`A <a@b.c> B <v@x.y>`, `<a@b.c> v@x.y`,
 * `<a@b.c>; v@x.y`), an address in the phrase before `<` (`a@b.c <v@x.y>`),
 * a `:` that would open a group where none can start, a `;` that closes no
 * group, a comment, quote or literal left open (it would swallow the rest),
 * or two words of an address with nothing between them (`a b@c.d`, which a
 * reader glues into `ab@c.d`). It follows `parseAddressList`'s grouping, so
 * whatever it lets through parses to every mailbox written.
 */
export function hasStrayText(value: string): boolean {
	let inAngle = false;
	let closed = false;
	let inGroup = false;
	let phraseHasAt = false;
	/** The element so far: whether two words touch, and whether it has `<…>`. */
	let wordLast = false;
	let wordsTouch = false;
	let angled = false;
	const elementEnds = () => {
		const bareGlued = wordsTouch && !angled;
		wordLast = false;
		wordsTouch = false;
		angled = false;
		return bareGlued;
	};
	for (const token of tokenize(value, ADDRESS_SPECIALS)) {
		if ('unterminated' in token && token.unterminated) return true;
		if (token.kind === 'space' || token.kind === 'comment') continue;
		const word = token.kind === 'atom' || token.kind === 'quoted';
		if (word && wordLast) {
			if (inAngle) return true;
			wordsTouch = true;
		}
		wordLast = word;
		const special = token.kind === 'special' && !inAngle ? token.value : '';
		if (special === ',') {
			if (elementEnds()) return true;
			closed = false;
			phraseHasAt = false;
			continue;
		}
		if (special === ':') {
			if (inGroup || closed || phraseHasAt) return true;
			// A group's name is a phrase: its words may touch.
			elementEnds();
			inGroup = true;
			continue;
		}
		if (special === ';') {
			if (!inGroup || elementEnds()) return true;
			inGroup = false;
			closed = false;
			phraseHasAt = false;
			continue;
		}
		if (closed) return true;
		if (special === '@') phraseHasAt = true;
		if (special === '<') {
			if (phraseHasAt) return true;
			inAngle = true;
			angled = true;
			wordLast = false;
		}
		if (token.kind === 'special' && token.value === '>' && inAngle) {
			inAngle = false;
			closed = true;
		}
	}
	return inAngle || elementEnds();
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
		INVISIBLE.test(address) ||
		!(DOT_ATOM.test(local) || QUOTED.test(local)) ||
		!DOMAIN.test(domain)
	) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`${caller}: "${shown(address)}" is not an e-mail address`,
		);
	}
	return address;
}
