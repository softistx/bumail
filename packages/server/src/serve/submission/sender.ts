import { addressOf } from '../../directory/address';
import type { Directory } from '../../directory/directory';
import { fieldName, splitFields } from '../header';

/** What a session keeps from its login: the user's version then, which a new password, a disable and an enable bump. */
export const LOGIN_VERSION = 'bumail.loginVersion';

/**
 * The user a session authenticated as, as the directory keeps it:
 * `@bumail/smtp` keeps the login as typed (`Alice@Example.COM`).
 * `undefined` when it is no longer a user, is disabled, or changed
 * since the login (`version`, kept at the login, as the login cache
 * checks it): a session open across `bumail user disable` or a new
 * password sends nothing more.
 */
export function userOf(
	directory: Directory,
	login: string | undefined,
	version: unknown,
): string | undefined {
	const parsed = login === undefined ? undefined : addressOf(login);
	if (parsed === undefined) return undefined;
	const user = directory.users.get(parsed.address);
	if (user === undefined || user.disabled) return undefined;
	if (directory.users.version(user.address) !== version) return undefined;
	return user.address;
}

/**
 * Whether `user` may send as `address`: its own address, or an alias
 * one of whose users it is, in any spelling the directory reads as one.
 * The null sender is nobody's.
 */
export function sendsAs(
	directory: Directory,
	user: string,
	address: string,
): boolean {
	const parsed = addressOf(address);
	if (parsed === undefined) return false;
	if (parsed.address === user) return true;
	return directory.aliases.targets(parsed.address).includes(user);
}

/** What separates the tokens of a From value: white space, brackets, quotes, comments, list and group marks. */
const DELIMITERS = /[\s<>()",;:[\]\\]+/;

/** A token that is an `addr-spec` as it appears in a From value: one `@`, something either side. */
const ADDRESS = /^[^@]+@[^@]+$/;

/** The longest From field read, in bytes: anything longer is no one's honest From. */
const MAX_FROM_BYTES = 64 * 1024;

/** `@`, and the characters a reader shows as one: FULLWIDTH and SMALL COMMERCIAL AT. */
const AT_LIKE = /[@＠﹫]/;

/** Strict UTF-8: bytes that are not whole, valid characters throw. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `bytes` as UTF-8, or `undefined` when they are not whole, valid UTF-8. */
function utf8(bytes: Uint8Array): string | undefined {
	try {
		return decoder.decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * One encoded-word (RFC 2047 §2) exactly: a charset token, an optional
 * RFC 2231 `*language`, `B` or `Q`, then printable ASCII other than `?`
 * and white space. Sticky: it must start where it is tried.
 */
const ENCODED_WORD =
	/=\?([A-Za-z0-9!#$%&'*+\-^_`{|}~]+?)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([!->@-~]*)\?=/y;

/** B text, strictly: whole base64 groups, padding only at the end, no base64url. */
const STRICT_B =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Q text, strictly: every `=` followed by two hex digits. */
const STRICT_Q = /^(?:[^=]|=[0-9A-Fa-f]{2})*$/;

/**
 * The charsets a From display name may be encoded in: those every reader
 * decodes alike, one byte for one character or UTF-8. UTF-7 and the
 * multi-byte ones (ISO-2022-JP, Shift_JIS, GB2312, Big5, EUC-KR) are not
 * among them, nor KOI8-R.
 */
const CHARSETS = new Set([
	'utf-8',
	'us-ascii',
	...Array.from({ length: 16 }, (_, i) => `iso-8859-${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `windows-${1250 + i}`),
]);

/** The bytes of a strict B or Q word's text. */
function encodedBytes(encoding: string, text: string): Uint8Array {
	if (encoding === 'B') return Buffer.from(text, 'base64');
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '=') {
			bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			bytes.push(text[i] === '_' ? 0x20 : text.charCodeAt(i));
		}
	}
	return Uint8Array.from(bytes);
}

/**
 * Whether one encoded-word could show a reader an `@`: text that is not
 * strict B or Q, a charset off the list, a raw `@`, a byte 0x40, or a
 * UTF-8 word that is not whole characters (RFC 2047 §5: a reader joining
 * it to its neighbour could assemble ＠) or that decodes to ＠ or ﹫.
 * Each word is read on its own: one byte a character in the other
 * charsets, whole characters in UTF-8, so no neighbour completes it.
 */
function wordHidesAt(charset: string, encoding: string, text: string): boolean {
	if (!CHARSETS.has(charset.toLowerCase())) return true;
	if (!(encoding === 'B' ? STRICT_B : STRICT_Q).test(text)) return true;
	if (text.includes('@')) return true;
	const bytes = encodedBytes(encoding, text);
	if (bytes.includes(0x40)) return true;
	if (charset.toLowerCase() !== 'utf-8') return false;
	const decoded = utf8(bytes);
	return decoded === undefined || AT_LIKE.test(decoded);
}

/**
 * Whether the encoded-words of `value` could show a reader an `@`, read
 * as an allow-list: every `=?` must start a strict encoded-word (no white
 * space or fold inside it, a word that closes) that `wordHidesAt` passes.
 */
function hidesAt(value: string): boolean {
	let from = 0;
	for (;;) {
		const start = value.indexOf('=?', from);
		if (start === -1) return false;
		ENCODED_WORD.lastIndex = start;
		const match = ENCODED_WORD.exec(value);
		if (match === null) return true;
		const [word, charset = '', encoding = '', text = ''] = match;
		if (wordHidesAt(charset, encoding.toUpperCase(), text)) return true;
		from = start + word.length;
	}
}

/** Why a From field names no author this check can stand behind. */
export type FromProblem = 'count' | 'unreadable' | 'none';

/**
 * The addresses the From field of `header` names, read strictly:
 * `'count'` when the header has none, or several (RFC 5322 §3.6 asks for
 * one); `'none'` when it names no address at all (`undisclosed:;`).
 * Every `@` in the field must belong to a plain address: a quoted local
 * part, a domain literal, an `@` anywhere else, a look-alike `@`, or an
 * encoded-word (RFC 2047) that is not strict or could show one gives
 * `'unreadable'`, so a reader is never shown an author this check did
 * not see; so does a field over 64 KiB, or one that is not UTF-8. A display name or a comment that
 * holds an address is held to the same rule as the address. Linear in
 * the field's length.
 */
export function fromAddresses(
	header: Uint8Array,
): readonly string[] | FromProblem {
	const fields = splitFields(header).filter((f) => fieldName(f) === 'from');
	const [field] = fields;
	if (field === undefined || fields.length > 1) return 'count';
	if (field.length > MAX_FROM_BYTES) return 'unreadable';
	// Raw bytes that are not UTF-8 (Shift_JIS, GBK, Big5) are read
	// differently by each reader: none is taken.
	const text = utf8(field);
	if (text === undefined) return 'unreadable';
	const value = text.slice(text.indexOf(':') + 1).replace(/\r\n/g, '');
	if (/[＠﹫]/.test(value) || hidesAt(value)) return 'unreadable';
	const found: string[] = [];
	for (const token of value.split(DELIMITERS)) {
		if (!token.includes('@')) continue;
		// `a@b@c`, `@b`, `a@`: an `@` that belongs to no plain address.
		if (!ADDRESS.test(token)) return 'unreadable';
		found.push(token);
	}
	return found.length === 0 ? 'none' : found;
}

/**
 * Whether every author `header`'s From names is one `user` may send as;
 * `'count'` or `'none'` when it names no one author.
 */
export function fromIsYours(
	directory: Directory,
	user: string,
	header: Uint8Array,
): 'yes' | 'no' | 'count' | 'none' {
	const authors = fromAddresses(header);
	if (authors === 'count' || authors === 'none') return authors;
	if (authors === 'unreadable') return 'no';
	return authors.every((author) => sendsAs(directory, user, author))
		? 'yes'
		: 'no';
}
