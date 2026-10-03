import { literalMarker } from './reader';

/**
 * A command as the client sent it: its lines, and between each two the
 * literal the first one announced. `lines.length` is `literals.length + 1`.
 */
export interface Framed {
	readonly lines: readonly string[];
	readonly literals: readonly Uint8Array[];
}

/** A command that does not follow the grammar: answered `BAD`, with this text. */
export class SyntaxProblem extends Error {
	override readonly name = 'SyntaxProblem';
}

/** How deep parenthesised lists nest in one command before it is refused. */
export const MAX_DEPTH = 32;

/** ATOM-CHAR (RFC 9051 §9): printable ASCII but the atom-specials `(){ %*"\]`. */
const ATOM = /[!#$&'+-[^-z|}~]+/y;
/** ASTRING-CHAR: ATOM-CHAR and `]`. */
const ASTRING = /[!#$&'+-[\]-z|}~]+/y;
/** list-char: ATOM-CHAR, the list-wildcards `%*` and `]`. */
const LIST_CHARS = /[!#-'*-[\]-z|}~]+/y;
const DIGITS = /[0-9]+/y;
/** A FETCH item name, a SEARCH key: letters, digits, dots and dashes. */
const WORD = /[A-Za-z0-9.-]+/y;
/** A sequence set's characters: digits, `:`, `,`, `*` (and `$`, to refuse it by name). */
const SEQUENCE = /[0-9:,*$]+/y;
/** The inside of a BODY[…] before any field list. */
const SECTION = /[A-Za-z0-9.]*/y;

const decoder = new TextDecoder();

/**
 * Reads a framed command left to right, one grammar element at a time.
 * Every read is a sticky regular expression with a single quantifier, or
 * a character loop: linear in what it reads. A read that fails throws a
 * `SyntaxProblem`.
 */
export class Cursor {
	readonly #framed: Framed;
	#line = 0;
	#at = 0;
	depth = 0;

	constructor(framed: Framed) {
		this.#framed = framed;
	}

	get #text(): string {
		return this.#framed.lines[this.#line] as string;
	}

	/** The next character, or `''` at the end of the command. */
	peek(): string {
		return this.#text[this.#at] ?? '';
	}

	/** The command was read whole. */
	atEnd(): boolean {
		return (
			this.#at >= this.#text.length &&
			this.#line === this.#framed.lines.length - 1
		);
	}

	fail(message: string): never {
		throw new SyntaxProblem(message);
	}

	/** Takes `char` if it comes next. */
	take(char: string): boolean {
		if (this.#text.startsWith(char, this.#at)) {
			this.#at += char.length;
			return true;
		}
		return false;
	}

	expect(char: string, what = `"${char}"`): void {
		if (!this.take(char)) this.fail(`Expected ${what}`);
	}

	sp(): void {
		this.expect(' ', 'a space');
	}

	end(): void {
		if (!this.atEnd()) this.fail('Unexpected text at the end of the command');
	}

	#match(pattern: RegExp): string | undefined {
		pattern.lastIndex = this.#at;
		const match = pattern.exec(this.#text);
		if (!match) return undefined;
		this.#at = pattern.lastIndex;
		return match[0];
	}

	atom(what = 'an atom'): string {
		return this.#match(ATOM) ?? this.fail(`Expected ${what}`);
	}

	/** An atom that may hold `]`: a tag, a flag, a fetch item name. */
	astringAtom(): string | undefined {
		return this.#match(ASTRING);
	}

	/** A FETCH item or SEARCH key name. */
	itemName(): string {
		return this.#match(WORD) ?? this.fail('Expected a name');
	}

	/** The text of a sequence set, for `parseSequenceSet`. */
	sequenceText(): string {
		const text = this.#match(SEQUENCE) ?? this.fail('Expected a sequence set');
		if (text.includes('$')) this.fail('$ (SEARCHRES) is not supported');
		return text;
	}

	/** The name `itemName` would read, left unread. */
	peekWord(): string {
		WORD.lastIndex = this.#at;
		return WORD.exec(this.#text)?.[0] ?? '';
	}

	/** A section spec's part numbers and text, up to its field list or `]`. */
	sectionSpec(): string {
		return this.#match(SECTION) ?? '';
	}

	number(): number {
		const digits = this.#match(DIGITS);
		if (digits === undefined || digits.length > 10) {
			this.fail('Expected a number');
		}
		const value = Number(digits);
		if (value > 0xffffffff) this.fail('A number is at most 4294967295');
		return value;
	}

	/** A quoted string or a literal, as bytes. */
	stringBytes(): Uint8Array {
		if (this.peek() === '"') return new TextEncoder().encode(this.#quoted());
		if (this.peek() === '{') return this.#literal();
		return this.fail('Expected a string');
	}

	string(): string {
		if (this.peek() === '"') return this.#quoted();
		return decoder.decode(this.stringBytes());
	}

	/** An atom (ASTRING-CHAR) or a string. */
	astring(): string {
		const peek = this.peek();
		if (peek === '"' || peek === '{') return this.string();
		return this.astringAtom() ?? this.fail('Expected an atom or a string');
	}

	/** `NIL`, or a string. */
	nstring(): string | undefined {
		if (this.#text.slice(this.#at, this.#at + 3).toUpperCase() === 'NIL') {
			this.#at += 3;
			return undefined;
		}
		return this.string();
	}

	/** A flag (RFC 9051 §9): a system flag such as `\Seen`, or a keyword; `\*` too with `star`. */
	flag(star = false): string {
		if (this.take('\\')) {
			if (star && this.take('*')) return '\\*';
			return `\\${this.atom('a flag')}`;
		}
		return this.atom('a flag');
	}

	/** A LIST pattern: list-char atoms, wildcards included, or a string. */
	listMailbox(): string {
		const peek = this.peek();
		if (peek === '"' || peek === '{') return this.string();
		return this.#match(LIST_CHARS) ?? this.fail('Expected a mailbox pattern');
	}

	#quoted(): string {
		const text = this.#text;
		let out = '';
		let at = this.#at + 1;
		let start = at;
		for (;;) {
			const char = text[at];
			if (char === undefined) this.fail('Unterminated quoted string');
			if (char === '\r') this.fail('A quoted string cannot hold a CR');
			if (char === '"') break;
			if (char === '\\') {
				const next = text[at + 1];
				if (next !== '"' && next !== '\\') {
					this.fail('A quoted string escapes only " and \\');
				}
				out += text.slice(start, at) + next;
				at += 2;
				start = at;
				continue;
			}
			at++;
		}
		out += text.slice(start, at);
		this.#at = at + 1;
		return out;
	}

	/**
	 * Whether what is left of the command is a literal's marker whose bytes
	 * are still to come: APPEND's message, before it is read.
	 */
	restIsPendingLiteral(): boolean {
		const rest = this.#text.slice(this.#at);
		return (
			this.#line === this.#framed.lines.length - 1 &&
			this.#framed.literals[this.#line] === undefined &&
			literalMarker(rest) !== undefined &&
			rest.lastIndexOf('{') === 0
		);
	}

	#literal(): Uint8Array {
		const rest = this.#text.slice(this.#at);
		const marker = literalMarker(rest);
		const bytes = this.#framed.literals[this.#line];
		// The marker is the whole rest of the line: its only `{` is the first.
		if (!marker || rest.lastIndexOf('{') !== 0 || bytes === undefined) {
			this.fail('A literal ends its line: {size}');
		}
		this.#line++;
		this.#at = 0;
		return bytes;
	}

	/**
	 * A parenthesised list: `(` items separated by single spaces `)`, an
	 * empty one allowed. Nesting deeper than `MAX_DEPTH` is refused.
	 */
	list<T>(item: (cursor: Cursor) => T): T[] {
		this.expect('(');
		if (++this.depth > MAX_DEPTH) this.fail('Lists nest too deep');
		const items: T[] = [];
		if (!this.take(')')) {
			do items.push(item(this));
			while (this.take(' '));
			this.expect(')');
		}
		this.depth--;
		return items;
	}
}
