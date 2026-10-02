/** A lexical token of a structured header field (RFC 5322 §3.2). */
export type Token =
	| { readonly kind: 'atom'; readonly value: string }
	| { readonly kind: 'quoted'; readonly value: string }
	| { readonly kind: 'comment'; readonly value: string }
	| { readonly kind: 'literal'; readonly value: string }
	| { readonly kind: 'special'; readonly value: string }
	| { readonly kind: 'space'; readonly value: string };

/**
 * Splits a structured value into tokens. `specials` are the characters that
 * end an atom: RFC 5322's for addresses, RFC 2045's tspecials for MIME
 * parameters. Quoted-strings and comments lose their delimiters and their
 * quoted-pairs; comments nest. An unterminated one runs to the end of the
 * value rather than failing.
 */
export function tokenize(value: string, specials: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < value.length) {
		const char = value[i] as string;
		if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
			let end = i + 1;
			while (end < value.length && /[ \t\r\n]/.test(value[end] as string))
				end++;
			tokens.push({ kind: 'space', value: value.slice(i, end) });
			i = end;
		} else if (char === '"') {
			let text = '';
			i++;
			while (i < value.length && value[i] !== '"') {
				if (value[i] === '\\' && i + 1 < value.length) i++;
				text += value[i];
				i++;
			}
			i++;
			tokens.push({ kind: 'quoted', value: text });
		} else if (char === '(') {
			let depth = 1;
			let text = '';
			i++;
			while (i < value.length && depth > 0) {
				const c = value[i] as string;
				if (c === '\\' && i + 1 < value.length) {
					text += value[i + 1];
					i += 2;
					continue;
				}
				if (c === '(') depth++;
				if (c === ')') depth--;
				if (depth > 0) text += c;
				i++;
			}
			tokens.push({ kind: 'comment', value: text });
		} else if (char === '[' && specials.includes('[')) {
			const end = value.indexOf(']', i);
			const stop = end < 0 ? value.length : end + 1;
			tokens.push({ kind: 'literal', value: value.slice(i, stop) });
			i = stop;
		} else if (specials.includes(char)) {
			tokens.push({ kind: 'special', value: char });
			i++;
		} else {
			let end = i + 1;
			while (
				end < value.length &&
				!specials.includes(value[end] as string) &&
				!/[ \t\r\n"(]/.test(value[end] as string)
			)
				end++;
			tokens.push({ kind: 'atom', value: value.slice(i, end) });
			i = end;
		}
	}
	return tokens;
}

/** RFC 5322 §3.2.3's specials, which end an atom in an address. */
export const ADDRESS_SPECIALS = '()<>[]:;@\\,."';

/** RFC 2045 §5.1's tspecials, which end a token in a MIME header. */
export const MIME_SPECIALS = '()<>@,;:\\"/[]?=';
