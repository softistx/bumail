import { decodeEncodedWords } from '@bumail/mime';
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

/** Why a From field names no author this check can stand behind. */
export type FromProblem = 'count' | 'unreadable' | 'none';

/**
 * The addresses the From field of `header` names, read strictly:
 * `'count'` when the header has none, or several (RFC 5322 §3.6 asks for
 * one); `'none'` when it names no address at all (`undisclosed:;`).
 * Every `@` in the field, encoded-words (RFC 2047) decoded, must belong
 * to a plain address: a quoted local part, a domain literal, or an `@`
 * anywhere else gives `'unreadable'`, so a reader is never shown an
 * author this check did not see. A display name or a comment that holds
 * an address, `=?UTF-8?Q?ceo=40bank.example?=` included, is held to the
 * same rule as the address.
 */
export function fromAddresses(
	header: Uint8Array,
): readonly string[] | FromProblem {
	const fields = splitFields(header).filter((f) => fieldName(f) === 'from');
	const [field] = fields;
	if (field === undefined || fields.length > 1) return 'count';
	const text = decoder.decode(field);
	const value = text.slice(text.indexOf(':') + 1).replace(/\r\n/g, '');
	// An address is never an encoded-word; a display name or a comment may
	// be one, and a reader is shown it decoded.
	const found = value.match(ADDRESS) ?? [];
	const ats = decodeEncodedWords(value).split('@').length - 1;
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
