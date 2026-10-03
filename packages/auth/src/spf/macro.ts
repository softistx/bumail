/**
 * RFC 7208 §7 macros: `%{s l o d i p h c r t v}` with an optional count,
 * `r` (reverse) and delimiters, and the escapes `%%`, `%_` and `%-`.
 * Parsing is one index scan; a macro-string is checked whole before
 * anything is looked up, so a syntax error is a `permerror` wherever it is.
 */

/** One `%{…}`. */
export interface Macro {
	/** The letter, lowercased. */
	readonly letter: string;
	/** An uppercase letter: the value is URL-escaped (§7.3). */
	readonly escape: boolean;
	/** Right-hand parts kept; `undefined` keeps every part. */
	readonly keep?: number;
	readonly reverse: boolean;
	/** The delimiters to split on, `.` when none is given. */
	readonly delimiters: string;
}

/** A parsed macro-string: literal text and macros, in order. */
export type MacroString = readonly (string | Macro)[];

/** A macro-string as parsed, and whether it ends with a macro or an escape (§7.1's `macro-expand`). */
export interface Parsed {
	readonly parts: MacroString;
	readonly endsWithMacro: boolean;
}

/** What is being parsed: a domain-spec, an explanation, or another modifier's value. */
export type MacroKind = 'domain' | 'explanation' | 'value';

const LETTERS = 'slodiphv';
const EXPLANATION_LETTERS = 'slodiphvcrt';
const DELIMITERS = '.-+,/_=';

/** Whatever count is past this keeps every part anyway: a name has at most 127 labels. */
const KEEP_CAP = 1000;

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/** The inside of `%{…}`, or why it is refused. */
function macroOf(body: string, kind: MacroKind): Macro | string {
	const first = body.charAt(0);
	const letter = first.toLowerCase();
	const letters = kind === 'domain' ? LETTERS : EXPLANATION_LETTERS;
	if (first === '' || !/[a-z]/i.test(first) || !letters.includes(letter)) {
		return `unknown macro %{${body}}`;
	}
	let i = 1;
	let keep: number | undefined;
	while (i < body.length && isDigit(body.charCodeAt(i))) {
		keep = Math.min(KEEP_CAP, (keep ?? 0) * 10 + body.charCodeAt(i) - 0x30);
		i++;
	}
	if (keep === 0) return `macro %{${body}} keeps zero parts`;
	const reverse = body.charAt(i).toLowerCase() === 'r';
	if (reverse) i++;
	for (let j = i; j < body.length; j++) {
		if (!DELIMITERS.includes(body.charAt(j))) {
			return `malformed macro %{${body}}`;
		}
	}
	return {
		letter,
		escape: first !== letter,
		...(keep === undefined ? {} : { keep }),
		reverse,
		delimiters: i < body.length ? body.slice(i) : '.',
	};
}

const ESCAPES: Readonly<Record<string, string>> = {
	'%': '%',
	_: ' ',
	'-': '%20',
};

function literalAllowed(code: number, kind: MacroKind): boolean {
	return (
		(code >= 0x21 && code <= 0x7e) || (kind === 'explanation' && code === 0x20)
	);
}

/**
 * A macro-string's parts, or why it is not one (§7.1). Only an explanation
 * may hold spaces. A domain-spec may not hold `%{c}`, `%{r}` or `%{t}`
 * (§7.2); an unknown modifier's value, never expanded, may.
 */
export function parseMacroString(
	text: string,
	kind: MacroKind,
): Parsed | string {
	const parts: (string | Macro)[] = [];
	let literal = '';
	let endsWithMacro = false;
	let i = 0;
	while (i < text.length) {
		endsWithMacro = text.charCodeAt(i) === 0x25;
		const code = text.charCodeAt(i);
		if (code !== 0x25) {
			if (!literalAllowed(code, kind)) {
				return `character ${JSON.stringify(text.charAt(i))} in ${JSON.stringify(text)}`;
			}
			literal += text.charAt(i);
			i++;
			continue;
		}
		const next = text.charAt(i + 1);
		const escaped = ESCAPES[next];
		if (escaped !== undefined) {
			literal += escaped;
			i += 2;
			continue;
		}
		const end = next === '{' ? text.indexOf('}', i + 2) : -1;
		if (end < 0) return `a "%" that starts no macro in ${JSON.stringify(text)}`;
		const macro = macroOf(text.slice(i + 2, end), kind);
		if (typeof macro === 'string') return macro;
		if (literal !== '') parts.push(literal);
		literal = '';
		parts.push(macro);
		i = end + 1;
	}
	if (literal !== '') parts.push(literal);
	return { parts, endsWithMacro };
}

/**
 * Whether a top label is one (§7.1): letters, digits and inner hyphens,
 * not all digits unless it holds a hyphen. An index scan, never a
 * regular expression: the label is the record's to make long.
 */
function isTopLabel(label: string): boolean {
	if (label.length === 0) return false;
	let letter = false;
	let hyphen = false;
	for (let i = 0; i < label.length; i++) {
		const code = label.charCodeAt(i) | 0x20;
		if (code >= 0x61 && code <= 0x7a) letter = true;
		else if (label.charCodeAt(i) === 0x2d) hyphen = true;
		else if (!isDigit(label.charCodeAt(i))) return false;
	}
	const edge = (c: number) => c !== 0x2d;
	return (
		edge(label.charCodeAt(0)) &&
		edge(label.charCodeAt(label.length - 1)) &&
		(letter || hyphen)
	);
}

/** Whether a domain-spec ends as §7.1's `domain-end` says: a macro, or `.` and a top label, a final `.` allowed. */
export function endsAsDomain(text: string, parsed: Parsed): boolean {
	if (parsed.endsWithMacro) return true;
	const body = text.endsWith('.') ? text.slice(0, -1) : text;
	const dot = body.lastIndexOf('.');
	return dot >= 0 && isTopLabel(body.slice(dot + 1));
}
