import { hasControl } from '../encoding/bytes';
import { MimeError } from '../errors';
import { checkAddress } from './address-check';

export { checkAddress, hasStrayText, shown } from './address-check';

import { decodeEncodedWords, encodeWord } from './encoded-words';
import { ADDRESS_SPECIALS, type Token, tokenize } from './tokens';

/** One mailbox (RFC 5322 §3.4): a display name, possibly empty, and an address. */
export interface Mailbox {
	readonly name: string;
	readonly address: string;
}

/** A named group of mailboxes (RFC 5322 §3.4), such as `undisclosed-recipients:;`. */
export interface Group {
	readonly group: string;
	readonly members: readonly Mailbox[];
}

export type Address = Mailbox | Group;

function phraseOf(tokens: readonly Token[]): string {
	const words: string[] = [];
	for (const token of tokens) {
		if (token.kind === 'atom' || token.kind === 'quoted') {
			words.push(token.value);
		} else if (token.kind === 'special' && token.value === '.') {
			// obs-phrase (RFC 5322 §4.1): `John Q. Public`.
			words[words.length - 1] = `${words[words.length - 1] ?? ''}.`;
		}
	}
	// Decoded once joined: the space between two encoded-words is dropped
	// (RFC 2047 §6.2), so they cannot be decoded one atom at a time.
	return decodeEncodedWords(words.join(' ')).replace(/\s+/g, ' ').trim();
}

const NEEDS_QUOTING = /[^A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]/;

/** The local part as it must be written: quoted when it is not a dot-atom. */
function localPart(text: string): string {
	return NEEDS_QUOTING.test(text) || /^\.|\.\.|\.$/.test(text)
		? `"${text.replace(/(["\\])/g, '\\$1')}"`
		: text;
}

/** An addr-spec from its tokens: comments and white space dropped. */
function addrSpecOf(tokens: readonly Token[]): string {
	let out = '';
	const at = tokens.findIndex(
		(token) => token.kind === 'special' && token.value === '@',
	);
	tokens.forEach((token, i) => {
		if (token.kind === 'space' || token.kind === 'comment') return;
		out +=
			token.kind === 'quoted' && (at < 0 || i < at)
				? localPart(token.value)
				: token.value;
	});
	return out;
}

function mailboxOf(tokens: readonly Token[]): Mailbox | undefined {
	const open = tokens.findIndex(
		(token) => token.kind === 'special' && token.value === '<',
	);
	if (open >= 0) {
		let close = tokens.findIndex(
			(token, i) => i > open && token.kind === 'special' && token.value === '>',
		);
		if (close < 0) close = tokens.length;
		let inside = tokens.slice(open + 1, close);
		// obs-route (RFC 5322 §4.4): `<@a.example,@b.example:user@c.example>`.
		const colon = inside.findIndex(
			(token) => token.kind === 'special' && token.value === ':',
		);
		if (colon >= 0) inside = inside.slice(colon + 1);
		return {
			name: phraseOf(tokens.slice(0, open)),
			address: addrSpecOf(inside),
		};
	}
	const address = addrSpecOf(tokens);
	if (address === '') return undefined;
	// `user@example.com (Name)`: the old convention puts the name in a comment.
	const comment = tokens.findLast((token) => token.kind === 'comment');
	return {
		name: comment ? decodeEncodedWords(comment.value).trim() : '',
		address,
	};
}

/**
 * Parses an address list — `From`, `To`, `Cc`, `Reply-To` — into mailboxes
 * and groups (RFC 5322 §3.4, with §4.4's obsolete forms). Display names
 * have their quotes and encoded-words decoded. It never throws: what it
 * cannot read as an address is left out.
 */
export function parseAddressList(value: string): Address[] {
	const tokens = tokenize(value, ADDRESS_SPECIALS);
	const result: Address[] = [];
	let current: Token[] = [];
	let group: { name: string; members: Mailbox[] } | undefined;
	let inAngle = false;
	const flush = () => {
		const mailbox = mailboxOf(current);
		if (mailbox) (group ? group.members : result).push(mailbox);
		current = [];
	};
	for (const token of tokens) {
		if (token.kind === 'special') {
			if (token.value === '<') inAngle = true;
			if (token.value === '>') inAngle = false;
			if (!inAngle && token.value === ',') {
				flush();
				continue;
			}
			if (!inAngle && token.value === ':' && group === undefined) {
				group = { name: phraseOf(current), members: [] };
				current = [];
				continue;
			}
			if (!inAngle && token.value === ';' && group !== undefined) {
				flush();
				result.push({ group: group.name, members: group.members });
				group = undefined;
				continue;
			}
		}
		current.push(token);
	}
	flush();
	if (group) result.push({ group: group.name, members: group.members });
	return result;
}

/** Every mailbox of an address list, groups opened. */
export function mailboxesOf(addresses: readonly Address[]): Mailbox[] {
	return addresses.flatMap((address) =>
		'group' in address ? address.members : [address],
	);
}

const PLAIN_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/;

/**
 * A mailbox as a header writes it: `Name <user@example.com>`. A name that
 * is not ASCII is written whole as encoded-words (RFC 2047 §5(3)), so no
 * comma or bracket in it reaches the header raw; an ASCII name with a
 * special is quoted.
 */
export function formatMailbox(mailbox: Mailbox | string): string {
	const { name, address } =
		typeof mailbox === 'string' ? { name: '', address: mailbox } : mailbox;
	checkAddress(address, 'formatMailbox()');
	if (name === '') return address;
	if (hasControl(name)) {
		throw new MimeError(
			'INVALID_ADDRESS',
			'formatMailbox(): a display name cannot hold a line break or a control character',
		);
	}
	const phrase =
		!/^[\x20-\x7e]*$/.test(name) || /=\?/.test(name)
			? encodeWord(name)
			: PLAIN_PHRASE.test(name)
				? name
				: `"${name.replace(/(["\\])/g, '\\$1')}"`;
	return `${phrase} <${address}>`;
}
