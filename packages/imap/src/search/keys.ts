import { type Cursor, MAX_DEPTH } from '../protocol/cursor';
import { parseDate } from '../protocol/dates';
import { echo } from '../protocol/echo';
import { parseSequenceSet, type SequenceSet } from '../protocol/sequence';

/** A search key (RFC 9051 §6.4.4), parsed. */
export type SearchKey =
	| { readonly kind: 'const'; readonly value: boolean }
	| { readonly kind: 'flag'; readonly flag: string; readonly set: boolean }
	| {
			readonly kind: 'date';
			readonly sent: boolean;
			readonly op: 'BEFORE' | 'ON' | 'SINCE';
			readonly day: number;
	  }
	| { readonly kind: 'header'; readonly name: string; readonly value: string }
	| { readonly kind: 'text'; readonly body: boolean; readonly value: string }
	| { readonly kind: 'size'; readonly larger: boolean; readonly size: number }
	| { readonly kind: 'set'; readonly uid: boolean; readonly set: SequenceSet }
	| { readonly kind: 'not'; readonly key: SearchKey }
	| { readonly kind: 'or'; readonly left: SearchKey; readonly right: SearchKey }
	| { readonly kind: 'and'; readonly keys: readonly SearchKey[] };

const FLAGS: Record<string, [string, boolean]> = {
	ANSWERED: ['\\Answered', true],
	DELETED: ['\\Deleted', true],
	DRAFT: ['\\Draft', true],
	FLAGGED: ['\\Flagged', true],
	SEEN: ['\\Seen', true],
	UNANSWERED: ['\\Answered', false],
	UNDELETED: ['\\Deleted', false],
	UNDRAFT: ['\\Draft', false],
	UNFLAGGED: ['\\Flagged', false],
	UNSEEN: ['\\Seen', false],
};

/** IMAP4rev1's \Recent is never set here: RECENT and NEW match nothing, OLD everything. */
const CONSTANTS: Record<string, boolean> = {
	ALL: true,
	RECENT: false,
	NEW: false,
	OLD: true,
};

const HEADERS = new Set(['FROM', 'TO', 'CC', 'BCC', 'SUBJECT']);

function date(cursor: Cursor): number {
	return (
		parseDate(cursor.astring()) ??
		cursor.fail('Expected a date such as 1-Feb-1994')
	);
}

function nested(cursor: Cursor, read: () => SearchKey): SearchKey {
	if (++cursor.depth > MAX_DEPTH) cursor.fail('Search keys nest too deep');
	const key = read();
	cursor.depth--;
	return key;
}

/** A key that takes an argument after its name. */
function withArgument(cursor: Cursor, name: string): SearchKey | undefined {
	if (name === 'KEYWORD' || name === 'UNKEYWORD') {
		return {
			kind: 'flag',
			flag: cursor.atom('a keyword'),
			set: name === 'KEYWORD',
		};
	}
	const dated = /^(SENT)?(BEFORE|ON|SINCE)$/.exec(name);
	if (dated) {
		return {
			kind: 'date',
			sent: dated[1] !== undefined,
			op: dated[2] as 'ON',
			day: date(cursor),
		};
	}
	if (HEADERS.has(name))
		return {
			kind: 'header',
			name: name.toLowerCase(),
			value: cursor.astring(),
		};
	if (name === 'HEADER') {
		const field = cursor.astring().toLowerCase();
		cursor.sp();
		return { kind: 'header', name: field, value: cursor.astring() };
	}
	if (name === 'TEXT' || name === 'BODY') {
		return { kind: 'text', body: name === 'BODY', value: cursor.astring() };
	}
	if (name === 'LARGER' || name === 'SMALLER') {
		return { kind: 'size', larger: name === 'LARGER', size: cursor.number() };
	}
	if (name === 'UID') {
		const set = parseSequenceSet(cursor.sequenceText());
		return set
			? { kind: 'set', uid: true, set }
			: cursor.fail('Expected a UID set');
	}
	if (name === 'NOT')
		return nested(cursor, () => ({ kind: 'not', key: searchKey(cursor) }));
	if (name === 'OR') {
		return nested(cursor, () => {
			const left = searchKey(cursor);
			cursor.sp();
			return { kind: 'or', left, right: searchKey(cursor) };
		});
	}
	return undefined;
}

/** One search key. */
export function searchKey(cursor: Cursor): SearchKey {
	const peek = cursor.peek();
	if (peek === '(') {
		return nested(cursor, () => ({
			kind: 'and',
			keys: cursor.list(searchKey),
		}));
	}
	if (peek === '*' || (peek >= '0' && peek <= '9')) {
		const set = parseSequenceSet(cursor.sequenceText());
		return set
			? { kind: 'set', uid: false, set }
			: cursor.fail('Expected a sequence set');
	}
	const name = cursor.itemName().toUpperCase();
	const flag = FLAGS[name];
	if (flag) return { kind: 'flag', flag: flag[0], set: flag[1] };
	const constant = CONSTANTS[name];
	if (constant !== undefined) return { kind: 'const', value: constant };
	if (!cursor.take(' '))
		cursor.fail(`Unknown search key ${echo(name)}, or its argument is missing`);
	return (
		withArgument(cursor, name) ??
		cursor.fail(`Unknown search key ${echo(name)}`)
	);
}

/** TEXT and BODY keys in one SEARCH: each one reads every message through. */
export const MAX_CONTENT_KEYS = 32;

function contentKeys(key: SearchKey): number {
	switch (key.kind) {
		case 'text':
			return 1;
		case 'not':
			return contentKeys(key.key);
		case 'or':
			return contentKeys(key.left) + contentKeys(key.right);
		case 'and':
			return key.keys.reduce((sum, inner) => sum + contentKeys(inner), 0);
		default:
			return 0;
	}
}

/** Every key to the end of the command: they all must match. */
export function searchKeys(cursor: Cursor): SearchKey {
	const keys = [searchKey(cursor)];
	while (cursor.take(' ')) keys.push(searchKey(cursor));
	cursor.end();
	const key: SearchKey =
		keys.length === 1 ? (keys[0] as SearchKey) : { kind: 'and', keys };
	if (contentKeys(key) > MAX_CONTENT_KEYS) {
		cursor.fail(
			`More than ${MAX_CONTENT_KEYS} TEXT or BODY keys in one SEARCH`,
		);
	}
	return key;
}
