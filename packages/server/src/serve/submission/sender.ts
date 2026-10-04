import { addressOf } from '../../directory/address';
import type { Directory } from '../../directory/directory';
import { fieldName, splitFields } from '../header';

/**
 * The user a session authenticated as, as the directory keeps it:
 * `@bumail/smtp` keeps the login as typed (`Alice@Example.COM`).
 * `undefined` when it is no longer a user.
 */
export function userOf(
	directory: Directory,
	login: string | undefined,
): string | undefined {
	const parsed = login === undefined ? undefined : addressOf(login);
	if (parsed === undefined) return undefined;
	return directory.users.get(parsed.address)?.address;
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
 * The addresses the From field of `header` names, read strictly:
 * `'count'` when the header has none, or several (RFC 5322 §3.6 asks for
 * one). Every `@` in the field must belong to a plain address: a quoted
 * local part, a domain literal, or an `@` anywhere else gives
 * `'unreadable'`, so a reader is never shown an author this check did
 * not see. A display name or a comment that holds an address is held to
 * the same rule as the address.
 */
export function fromAddresses(
	header: Uint8Array,
): readonly string[] | 'count' | 'unreadable' {
	const fields = splitFields(header).filter((f) => fieldName(f) === 'from');
	const [field] = fields;
	if (field === undefined || fields.length > 1) return 'count';
	const text = decoder.decode(field);
	const value = text.slice(text.indexOf(':') + 1).replace(/\r\n/g, '');
	const found = value.match(ADDRESS) ?? [];
	const ats = value.split('@').length - 1;
	if (found.length === 0 || ats !== found.length) return 'unreadable';
	return found;
}

/** Whether every author `header`'s From names is one `user` may send as. */
export function fromIsYours(
	directory: Directory,
	user: string,
	header: Uint8Array,
): 'yes' | 'no' | 'count' {
	const authors = fromAddresses(header);
	if (authors === 'count') return 'count';
	if (authors === 'unreadable') return 'no';
	return authors.every((author) => sendsAs(directory, user, author))
		? 'yes'
		: 'no';
}
