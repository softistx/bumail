/**
 * The one mailbox of a From field, read strictly (RFC 5322 §3.4).
 *
 * `@bumail/mime`'s `parseAddressList` is lenient on purpose: it never
 * throws, and leaves out what it cannot read. For DMARC that leniency is
 * the attack. `a@good.example <x@evil.example>` reads there as one mailbox
 * at evil.example while a mail client may show good.example, and a stray
 * `>` or an unterminated quote leaves a reader and this check to disagree
 * on which domain is the author. So DMARC reads From with its own grammar,
 * which takes one `mailbox` — `addr-spec`, or `[display-name] <addr-spec>`
 * — with comments and folding white space anywhere between tokens, and
 * refuses everything else: an unterminated quoted-string or comment, a
 * control character, a display name holding `@` or `<`, a second angle
 * address, text after the `>`, an obs-route, an empty list element. A
 * group (RFC 6854) is refused too: its name is what a reader is shown,
 * and it is not a domain DMARC can check.
 *
 * The domain is always the addr-spec's, after its last unquoted `@`; a
 * display name is never read, whatever it holds.
 */

/** A lexical token of the From value: a word, a special, or a domain literal. */
type Token =
	| { readonly kind: 'atom' | 'quoted' | 'literal'; readonly value: string }
	| { readonly kind: 'special'; readonly value: string };

/** What the From value holds: one address's local part and domain, or why not. */
export type FromMailbox =
	| { readonly domain: string; readonly literal: boolean }
	| {
			readonly problem: 'empty' | 'unparsable' | 'several' | 'group';
	  };

const SPECIALS = '()<>[]:;@\\,."';

function isWsp(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/** Any C0 control but HTAB, CR and LF (folding), and DEL. */
function isControl(code: number): boolean {
	return (code < 0x20 && code !== 0x09) || code === 0x7f;
}

/** The index past a quoted-string or comment opened at `start`, or -1 when it never closes. */
function closing(value: string, start: number, nests: boolean): number {
	const close = nests ? ')' : '"';
	let depth = 1;
	let i = start + 1;
	while (i < value.length) {
		const char = value[i] as string;
		if (char === '\\') {
			i += 2;
			continue;
		}
		if (nests && char === '(') depth++;
		else if (char === close) {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	return -1;
}

function unescaped(text: string): string {
	return text.replace(/\\(.)/gs, '$1');
}

/**
 * The tokens of `value`, comments and white space dropped, or `undefined`
 * when it holds a control character or something left open.
 */
function tokenize(value: string): Token[] | undefined {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (isControl(code) && code !== 0x0d && code !== 0x0a) return undefined;
	}
	// A CR or LF is folding only as CRLF before white space: a bare one may
	// end the field for a reader.
	if (/\r(?!\n[ \t])|(?<!\r)\n|\r\n(?![ \t])/.test(value)) return undefined;
	const tokens: Token[] = [];
	let i = 0;
	while (i < value.length) {
		const char = value[i] as string;
		if (isWsp(char)) {
			i++;
		} else if (char === '(' || char === '"') {
			const end = closing(value, i, char === '(');
			if (end < 0) return undefined;
			if (char === '"') {
				tokens.push({
					kind: 'quoted',
					value: unescaped(value.slice(i + 1, end - 1)),
				});
			}
			i = end;
		} else if (char === '[') {
			const end = value.indexOf(']', i);
			if (end < 0) return undefined;
			tokens.push({ kind: 'literal', value: value.slice(i, end + 1) });
			i = end + 1;
		} else if (char === ')' || char === ']' || char === '\\') {
			return undefined;
		} else if (SPECIALS.includes(char)) {
			tokens.push({ kind: 'special', value: char });
			i++;
		} else {
			let end = i + 1;
			while (
				end < value.length &&
				!SPECIALS.includes(value[end] as string) &&
				!isWsp(value[end] as string)
			) {
				end++;
			}
			tokens.push({ kind: 'atom', value: value.slice(i, end) });
			i = end;
		}
	}
	return tokens;
}

function isSpecial(token: Token | undefined, value: string): boolean {
	return token?.kind === 'special' && token.value === value;
}

function isWord(token: Token | undefined): boolean {
	return token?.kind === 'atom' || token?.kind === 'quoted';
}

/** `word *("." word)`: a local part, or (with words of atoms only) a domain. */
function dotted(tokens: readonly Token[], atomsOnly: boolean): boolean {
	if (tokens.length % 2 === 0) return false;
	return tokens.every((token, i) =>
		i % 2 === 1
			? isSpecial(token, '.')
			: atomsOnly
				? token.kind === 'atom'
				: isWord(token),
	);
}

/** An addr-spec's domain, or `undefined` when the tokens are not one. */
function addrSpec(tokens: readonly Token[]): FromMailbox | undefined {
	const ats = tokens.filter((token) => isSpecial(token, '@')).length;
	if (ats !== 1) return undefined;
	const at = tokens.findIndex((token) => isSpecial(token, '@'));
	const local = tokens.slice(0, at);
	const domain = tokens.slice(at + 1);
	if (!dotted(local, false)) return undefined;
	const only = domain[0];
	if (domain.length === 1 && only?.kind === 'literal') {
		return { domain: only.value, literal: true };
	}
	if (!dotted(domain, true)) return undefined;
	return {
		domain: domain.map((token) => token.value).join(''),
		literal: false,
	};
}

/** A display name: words, with obs-phrase's dots after the first (`John Q. Public`). */
function phrase(tokens: readonly Token[]): boolean {
	return tokens.every(
		(token, i) => isWord(token) || (i > 0 && isSpecial(token, '.')),
	);
}

/** The domain of one mailbox, or `undefined` when the tokens are not one. */
function mailbox(tokens: readonly Token[]): FromMailbox | undefined {
	const open = tokens.findIndex((token) => isSpecial(token, '<'));
	if (open < 0) return addrSpec(tokens);
	const close = tokens.length - 1;
	if (!isSpecial(tokens[close], '>') || close < open) return undefined;
	if (!phrase(tokens.slice(0, open))) return undefined;
	return addrSpec(tokens.slice(open + 1, close));
}

/** Reads one From field's value strictly: see the module's comment. */
export function fromMailbox(value: string): FromMailbox {
	const tokens = tokenize(value);
	if (tokens === undefined) return { problem: 'unparsable' };
	if (tokens.length === 0) return { problem: 'empty' };
	let angle = false;
	const parts: Token[][] = [[]];
	for (const token of tokens) {
		if (token.kind === 'special' && !angle) {
			if (token.value === ':') return { problem: 'group' };
			if (token.value === ',') {
				parts.push([]);
				continue;
			}
		}
		if (isSpecial(token, '<')) angle = true;
		if (isSpecial(token, '>')) angle = false;
		parts[parts.length - 1]?.push(token);
	}
	const filled = parts.filter((part) => part.length > 0);
	if (filled.length > 1) return { problem: 'several' };
	if (parts.length > 1) return { problem: 'unparsable' };
	return mailbox(tokens) ?? { problem: 'unparsable' };
}
