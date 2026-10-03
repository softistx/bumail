import type { Section } from '../message/section';
import type { Cursor } from '../protocol/cursor';

/** `<origin.length>`: part of a section (RFC 9051 §6.4.5). */
export interface Partial {
	readonly origin: number;
	readonly length: number;
}

/** One FETCH data item, as asked. */
export type FetchItem =
	| {
			readonly kind:
				| 'FLAGS'
				| 'UID'
				| 'INTERNALDATE'
				| 'RFC822.SIZE'
				| 'ENVELOPE';
	  }
	| { readonly kind: 'BODYSTRUCTURE' | 'BODY' }
	| {
			readonly kind: 'section';
			readonly section: Section;
			readonly peek: boolean;
			readonly partial?: Partial;
			/** RFC822, RFC822.HEADER or RFC822.TEXT: IMAP4rev1's names, answered under them. */
			readonly legacy?: string;
	  };

const SIMPLE = new Set([
	'FLAGS',
	'UID',
	'INTERNALDATE',
	'RFC822.SIZE',
	'ENVELOPE',
	'BODYSTRUCTURE',
]);

const MACROS: Record<string, readonly string[]> = {
	ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
	FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
	FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'],
};

const LEGACY: Record<string, FetchItem> = {
	RFC822: {
		kind: 'section',
		section: { path: [] },
		peek: false,
		legacy: 'RFC822',
	},
	'RFC822.HEADER': {
		kind: 'section',
		section: { path: [], text: 'HEADER' },
		peek: true,
		legacy: 'RFC822.HEADER',
	},
	'RFC822.TEXT': {
		kind: 'section',
		section: { path: [], text: 'TEXT' },
		peek: false,
		legacy: 'RFC822.TEXT',
	},
};

const TEXTS = new Set([
	'HEADER',
	'HEADER.FIELDS',
	'HEADER.FIELDS.NOT',
	'TEXT',
	'MIME',
]);

/** The inside of `[…]`: part numbers, then a section text, then field names. */
function section(cursor: Cursor): Section {
	const spec = cursor.sectionSpec();
	const words = spec === '' ? [] : spec.split('.');
	const path: number[] = [];
	while (words.length > 0 && /^[0-9]+$/.test(words[0] as string)) {
		const n = Number(words.shift());
		if (n < 1 || n > 0xffffffff) cursor.fail('A part number is at least 1');
		path.push(n);
	}
	const text = words.join('.').toUpperCase();
	if (text === '') return { path };
	if (!TEXTS.has(text)) cursor.fail(`Unknown section ${text}`);
	if (text === 'MIME' && path.length === 0)
		cursor.fail('MIME needs a part number');
	if (!text.startsWith('HEADER.FIELDS'))
		return { path, text: text as Section['text'] & string };
	cursor.sp();
	const fields = cursor.list((c) => c.astring());
	if (fields.length === 0) cursor.fail('HEADER.FIELDS needs a field name');
	return { path, text: text as 'HEADER.FIELDS', fields };
}

function partial(cursor: Cursor): Partial | undefined {
	if (!cursor.take('<')) return undefined;
	const origin = cursor.number();
	cursor.expect('.');
	const length = cursor.number();
	if (length === 0) cursor.fail('A partial length is at least 1');
	cursor.expect('>');
	return { origin, length };
}

function item(cursor: Cursor): FetchItem {
	const name = cursor.itemName().toUpperCase();
	if (SIMPLE.has(name) || (name === 'BODY' && cursor.peek() !== '[')) {
		return { kind: name as 'FLAGS' };
	}
	const legacy = LEGACY[name];
	if (legacy) return legacy;
	if (name === 'BODY' || name === 'BODY.PEEK') {
		cursor.expect('[');
		const spec = section(cursor);
		cursor.expect(']');
		const range = partial(cursor);
		return {
			kind: 'section',
			section: spec,
			peek: name === 'BODY.PEEK',
			...(range ? { partial: range } : {}),
		};
	}
	if (name.startsWith('BINARY')) cursor.fail('BINARY is not supported yet');
	return cursor.fail(`Unknown FETCH item ${name}`);
}

/** FETCH's items (RFC 9051 §6.4.5): a macro, one item, or a list of them. */
export function fetchItems(cursor: Cursor): FetchItem[] {
	if (cursor.peek() === '(') return cursor.list(item);
	const macro = MACROS[cursor.peekWord().toUpperCase()];
	if (macro) {
		cursor.itemName();
		return macro.map((name) => ({ kind: name as 'FLAGS' }));
	}
	return [item(cursor)];
}
