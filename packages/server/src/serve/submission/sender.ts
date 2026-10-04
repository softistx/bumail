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
 * Anything shaped like an encoded-word (RFC 2047): `=?charset?encoding?text?=`,
 * in any charset and any encoding letter, as broadly as a reader might
 * decode one.
 */
const ENCODED_WORD = /=\?[^?\s]*\?([^?\s]*)\?([^?\s]*)\?=/g;

/** The bytes of an encoded-word's text, read as B (base64) or Q; `undefined` for another encoding. */
function encodedBytes(encoding: string, text: string): Uint8Array | undefined {
	if (encoding.toUpperCase() === 'B') return Buffer.from(text, 'base64');
	if (encoding.toUpperCase() !== 'Q') return undefined;
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
 * Whether an encoded-word in `value` could show a reader an `@`: one
 * holding a raw `@` (an address hidden inside it), or whose B or Q text
 * holds the byte 0x40, whatever its charset says — a charset the
 * platform does not know is shown raw by one reader and decoded by
 * another, and UTF-16's `@` holds that byte too.
 */
function hidesAt(value: string): boolean {
	for (const [word, encoding = '', text = ''] of value.matchAll(ENCODED_WORD)) {
		if (word.slice(2).includes('@')) return true;
		if (encodedBytes(encoding, text)?.includes(0x40)) return true;
	}
	return false;
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
