/** Marks a string literal's place in the code: its index in `strings`. */
const MARK = '\u0001';
const LITERAL = `${MARK}(\\d+)${MARK}`;
/** A masked string that is not the specifier, such as a quoted export name. */
const ANY_LITERAL = `${MARK}\\d+${MARK}`;

/** Every form a declaration file names a module in, its specifier a literal. */
const FORMS = [
	// import … from 'x', import type … from 'x', export … from 'x', export * from
	// 'x', and export { "a-b" as ab } from 'x', a string before `from`
	new RegExp(
		`\\b(?:import|export)\\b(?:[^;${MARK}]|${ANY_LITERAL})*?\\bfrom\\s*${LITERAL}`,
		'g',
	),
	// import 'x'
	new RegExp(`\\bimport\\s*${LITERAL}`, 'g'),
	// import('x').T, and import('x', { with: { 'resolution-mode': 'import' } }).T
	new RegExp(`\\bimport\\s*\\(\\s*${LITERAL}\\s*[,)]`, 'g'),
	// import x = require('x'), import type x = require('x')
	new RegExp(
		`\\bimport\\s+(?:type\\s+)?[\\w$]+\\s*=\\s*require\\s*\\(\\s*${LITERAL}\\s*\\)`,
		'g',
	),
];

/** `/// <reference types="x" />`, read from a line comment that opens its line. */
const REFERENCE_TYPES = /^\/\/\/\s*<reference\s+types\s*=\s*(["'])([^"']+)\1/;

const ESCAPES: Readonly<Record<string, string>> = {
	n: '\n',
	r: '\r',
	t: '\t',
	b: '\b',
	f: '\f',
	v: '\v',
	'0': '\0',
};

/**
 * Reads a declaration file's code: comments removed, each string literal
 * replaced by a mark, and a template literal's `${…}` read as code, so that
 * neither a JSDoc example nor a string literal type can pass for an import.
 */
class Scanner {
	readonly strings: string[] = [];
	readonly references: string[] = [];
	#i = 0;

	constructor(readonly text: string) {}

	/** The code to the end of the text, or to the `}` that closes a template's `${`. */
	code(inSubstitution = false): string {
		const { text } = this;
		let code = '';
		let depth = 0;
		while (this.#i < text.length) {
			const char = text[this.#i] as string;
			const next = text[this.#i + 1];
			if (char === '/' && next === '/') {
				this.#lineComment(code);
			} else if (char === '/' && next === '*') {
				const end = text.indexOf('*/', this.#i + 2);
				this.#i = end < 0 ? text.length : end + 2;
				code += ' ';
			} else if (char === '"' || char === "'") {
				code += this.#mark(this.#string(char));
			} else if (char === '`') {
				code += this.#template();
			} else if (inSubstitution && char === '}' && depth === 0) {
				this.#i++;
				return code;
			} else {
				if (char === '{') depth++;
				if (char === '}') depth--;
				code += char;
				this.#i++;
			}
		}
		return code;
	}

	/** Skips a line comment, keeping a `/// <reference types>` that opens its line. */
	#lineComment(code: string): void {
		const end = this.text.indexOf('\n', this.#i);
		const stop = end < 0 ? this.text.length : end;
		if (code.slice(code.lastIndexOf('\n') + 1).trim() === '') {
			const reference = REFERENCE_TYPES.exec(this.text.slice(this.#i, stop));
			if (reference) this.references.push(reference[2] as string);
		}
		this.#i = stop;
	}

	#mark(value: string): string {
		return `${MARK}${this.strings.push(value) - 1}${MARK}`;
	}

	/** A quoted string, from its opening quote, its escapes decoded. */
	#string(quote: string): string {
		const { text } = this;
		let value = '';
		this.#i++;
		while (this.#i < text.length && text[this.#i] !== quote) {
			if (text[this.#i] === '\\') {
				value += this.#escape();
			} else {
				value += text[this.#i];
				this.#i++;
			}
		}
		this.#i++;
		return value;
	}

	/** A template literal: each text part masked, each `${…}` read as code. */
	#template(): string {
		const { text } = this;
		let code = '';
		let part = '';
		this.#i++;
		while (this.#i < text.length && text[this.#i] !== '`') {
			if (text[this.#i] === '\\') {
				part += this.#escape();
			} else if (text[this.#i] === '$' && text[this.#i + 1] === '{') {
				this.#i += 2;
				code += `${this.#mark(part)} ${this.code(true)} `;
				part = '';
			} else {
				part += text[this.#i];
				this.#i++;
			}
		}
		this.#i++;
		return `${code}${this.#mark(part)}`;
	}

	/** One escape, from its backslash: `\n`, `\x41`, `A`, `\u{1F600}`, or the character itself. */
	#escape(): string {
		const { text } = this;
		const char = text[this.#i + 1] ?? '';
		const hex = (from: number, length: number) =>
			String.fromCodePoint(
				Number.parseInt(text.slice(from, from + length), 16) || 0,
			);
		if (char === 'x') {
			this.#i += 4;
			return hex(this.#i - 2, 2);
		}
		if (char === 'u' && text[this.#i + 2] === '{') {
			const end = text.indexOf('}', this.#i);
			const value = hex(this.#i + 3, end - this.#i - 3);
			this.#i = end + 1;
			return value;
		}
		if (char === 'u') {
			this.#i += 6;
			return hex(this.#i - 4, 4);
		}
		this.#i += 2;
		return ESCAPES[char] ?? char;
	}
}

/**
 * The modules a `.d.ts` names, read without TypeScript's own API, which
 * TypeScript 7 no longer exports: every `import` and `export … from`
 * (type-only included), `import('x')` in a type (inside a template literal
 * type too), `import x = require('x')`, and `/// <reference types="x" />` at
 * the start of a line. Comments and string literals cannot pass for an
 * import, and string escapes are decoded. Built for what tsc emits; a
 * specifier that is not a literal is out of its reach.
 */
export function declarationSpecifiers(text: string): string[] {
	const scanner = new Scanner(text);
	const code = scanner.code();
	const found = [...scanner.references];
	for (const form of FORMS) {
		for (const match of code.matchAll(form)) {
			found.push(scanner.strings[Number(match[1])] as string);
		}
	}
	return found;
}
