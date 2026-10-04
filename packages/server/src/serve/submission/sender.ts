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

/** An `addr-spec` as it appears in a From value: no space, bracket, quote or comment around it. */
const ADDRESS = /[^\s<>()",;:@[\]\\]+@[^\s<>()",;:@[\]\\]+/gu;

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * One encoded-word (RFC 2047 §2) exactly: a charset token, an optional
 * RFC 2231 `*language`, `B` or `Q`, then printable ASCII other than `?`
 * and white space. Sticky: it must start where it is tried.
 */
const ENCODED_WORD =
	/=\?([A-Za-z0-9!#$%&'*+\-^_`{|}~]+?)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([!->@-~]*)\?=/y;

/** The charsets a From display name may be encoded in: those every reader decodes alike, UTF-7 not among them. */
const CHARSETS = new Set([
	'utf-8',
	'us-ascii',
	...Array.from({ length: 16 }, (_, i) => `iso-8859-${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `windows-${1250 + i}`),
]);

/** An encoded-word read: its charset, lowercase; `B` or `Q`; its text; where it ends. */
interface Word {
	readonly charset: string;
	readonly encoding: string;
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

/** The bytes of encoded text, B (base64, padding anywhere ignored) or Q. */
function encodedBytes(encoding: string, text: string): Uint8Array {
	if (encoding === 'B') return Buffer.from(text.replace(/=/g, ''), 'base64');
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const hex = text.slice(i + 1, i + 3);
		if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(text.charCodeAt(i) & 0xff);
		}
	}
	return Uint8Array.from(bytes);
}

/**
 * The encoded-words of `value`, read strictly, or `undefined` when one
 * `=?` in it starts no well-formed word in an allowed charset: white
 * space or a fold inside a word, a word never closed, a charset such as
 * UTF-7 or one this check does not know.
 */
function encodedWords(value: string): Word[] | undefined {
	const words: Word[] = [];
	let from = 0;
	for (;;) {
		const start = value.indexOf('=?', from);
		if (start === -1) return words;
		ENCODED_WORD.lastIndex = start;
		const match = ENCODED_WORD.exec(value);
		if (match === null) return undefined;
		const [word, charset = '', encoding = '', text = ''] = match;
		if (!CHARSETS.has(charset.toLowerCase())) return undefined;
		words.push({
			charset: charset.toLowerCase(),
			encoding: encoding.toUpperCase(),
			text,
			start,
			end: start + word.length,
		});
		from = start + word.length;
	}
}

/**
 * Whether the encoded-words of `value` could show a reader an `@`, read
 * as an allow-list: any `=?` that is not a strict encoded-word in an
 * allowed charset; a raw `@` in a word; a word, or a run of adjacent
 * words (nothing or white space between them) in one charset and
 * encoding joined as some readers join them, whose bytes hold 0x40 —
 * which catches an escape or a base64 group split across two words.
 */
function hidesAt(value: string): boolean {
	if (!value.includes('=?')) return false;
	const words = encodedWords(value);
	if (words === undefined) return true;
	let run: Word[] = [];
	const runHides = () =>
		run.length > 0 &&
		encodedBytes(
			run[0]?.encoding ?? 'Q',
			run.map((w) => w.text).join(''),
		).includes(0x40);
	for (const word of words) {
		if (word.text.includes('@')) return true;
		if (encodedBytes(word.encoding, word.text).includes(0x40)) return true;
		const last = run.at(-1);
		const adjacent =
			last !== undefined &&
			last.charset === word.charset &&
			last.encoding === word.encoding &&
			/^[ \t]*$/.test(value.slice(last.end, word.start));
		if (!adjacent) {
			if (runHides()) return true;
			run = [];
		}
		run.push(word);
	}
	return runHides();
}

/** Why a From field names no author this check can stand behind. */
export type FromProblem = 'count' | 'unreadable' | 'none';

/**
 * The addresses the From field of `header` names, read strictly:
 * `'count'` when the header has none, or several (RFC 5322 §3.6 asks for
 * one); `'none'` when it names no address at all (`undisclosed:;`).
 * Every `@` in the field must belong to a plain address: a quoted local
 * part, a domain literal, an `@` anywhere else, or an encoded-word (RFC
 * 2047) that holds or decodes to one gives `'unreadable'`, so a reader
 * is never shown an author this check did not see. A display name or a
 * comment that holds an address, `=?UTF-8?Q?ceo=40bank.example?=`
 * included, is held to the same rule as the address.
 */
export function fromAddresses(
	header: Uint8Array,
): readonly string[] | FromProblem {
	const fields = splitFields(header).filter((f) => fieldName(f) === 'from');
	const [field] = fields;
	if (field === undefined || fields.length > 1) return 'count';
	const text = decoder.decode(field);
	const value = text.slice(text.indexOf(':') + 1).replace(/\r\n/g, '');
	if (hidesAt(value)) return 'unreadable';
	const found = value.match(ADDRESS) ?? [];
	const ats = value.split('@').length - 1;
	if (found.length === 0 && ats === 0) return 'none';
	if (found.length === 0 || ats !== found.length) return 'unreadable';
	return found;
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
