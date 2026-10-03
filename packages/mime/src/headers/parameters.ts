import { join } from '../encoding/bytes';
import { charsetLabel, decodeCharset } from '../encoding/charset';
import { decodeEncodedWords } from './encoded-words';
import { MIME_SPECIALS, type Token, tokenize } from './tokens';

/** A `Content-Type` (RFC 2045 §5). */
export interface ContentType {
	/** `type/subtype`, lower case. */
	readonly mediaType: string;
	readonly type: string;
	readonly subtype: string;
	/** Parameter names in lower case, values decoded (RFC 2231). */
	readonly parameters: Readonly<Record<string, string>>;
}

/** A `Content-Disposition` (RFC 2183). */
export interface ContentDisposition {
	/** `inline`, `attachment`, or another type, lower case. */
	readonly type: string;
	readonly parameters: Readonly<Record<string, string>>;
}

interface Section {
	readonly index: number;
	readonly extended: boolean;
	readonly value: string;
}

function percentDecode(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string;
		const hex = text.slice(i + 1, i + 3);
		if (char === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			out.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			out.push(char.charCodeAt(0) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

/**
 * The parameters after a value's first `;`, with RFC 2231's extensions:
 * `name*=charset'language'%XX` values and `name*0`, `name*1*` continuations,
 * joined in numeric order. A value written as RFC 2047 encoded-words —
 * which RFC 2047 §5 forbids there, and mail clients send anyway — is
 * decoded too.
 */
export function parseParameters(
	tokens: readonly Token[],
): Record<string, string> {
	const sections = new Map<string, Section[]>();
	const plain = new Map<string, string>();
	const parts: Token[][] = [[]];
	for (const token of tokens) {
		if (token.kind === 'special' && token.value === ';') parts.push([]);
		else if (token.kind !== 'space' && token.kind !== 'comment')
			(parts[parts.length - 1] as Token[]).push(token);
	}
	for (const part of parts) {
		const equals = part.findIndex(
			(token) => token.kind === 'special' && token.value === '=',
		);
		if (equals <= 0) continue;
		const key = part
			.slice(0, equals)
			.map((token) => token.value)
			.join('')
			.toLowerCase();
		const value = part
			.slice(equals + 1)
			.map((token) => token.value)
			.join('');
		const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
		if (!match) continue;
		const [, name = '', index, star] = match;
		if (index === undefined && star === undefined) {
			if (!plain.has(name)) plain.set(name, value);
			continue;
		}
		const list = sections.get(name) ?? [];
		list.push({
			index: index === undefined ? 0 : Number(index),
			extended: star !== undefined,
			value,
		});
		sections.set(name, list);
	}

	const result: Record<string, string> = {};
	for (const [name, value] of plain) result[name] = decodeEncodedWords(value);
	for (const [name, list] of sections) {
		list.sort((a, b) => a.index - b.index);
		let charset = 'us-ascii';
		const first = list[0];
		if (first?.extended) {
			const quote = first.value.indexOf("'");
			const second = first.value.indexOf("'", quote + 1);
			if (quote >= 0 && second > quote) {
				charset = first.value.slice(0, quote) || 'us-ascii';
				list[0] = { ...first, value: first.value.slice(second + 1) };
			}
		}
		const raw = join(
			list.map((section) =>
				section.extended
					? percentDecode(section.value)
					: new TextEncoder().encode(section.value),
			),
		);
		result[name] =
			charsetLabel(charset) === undefined
				? decodeCharset(raw, 'utf-8')
				: decodeCharset(raw, charset);
	}
	return result;
}

/** The value before the first `;`, and the parameters after it. */
function splitValue(value: string): {
	head: Token[];
	parameters: Record<string, string>;
} {
	const tokens = tokenize(value, MIME_SPECIALS);
	const semicolon = tokens.findIndex(
		(token) => token.kind === 'special' && token.value === ';',
	);
	const end = semicolon < 0 ? tokens.length : semicolon;
	return {
		head: tokens
			.slice(0, end)
			.filter((token) => token.kind !== 'space' && token.kind !== 'comment'),
		parameters:
			semicolon < 0 ? {} : parseParameters(tokens.slice(semicolon + 1)),
	};
}

/** RFC 2045 §5.2: a missing or unreadable Content-Type is `text/plain; charset=us-ascii`. */
export const DEFAULT_CONTENT_TYPE: ContentType = {
	mediaType: 'text/plain',
	type: 'text',
	subtype: 'plain',
	parameters: { charset: 'us-ascii' },
};

/**
 * Parses a `Content-Type` value. A value with no `/` is unreadable and gives
 * the default, as RFC 2045 §5.2 asks, keeping any parameters it had.
 */
export function parseContentType(value: string | undefined): ContentType {
	if (value === undefined) return DEFAULT_CONTENT_TYPE;
	const { head, parameters } = splitValue(value);
	const slash = head.findIndex(
		(token) => token.kind === 'special' && token.value === '/',
	);
	const type = head[slash - 1]?.value.toLowerCase();
	const subtype = head[slash + 1]?.value.toLowerCase();
	if (slash < 0 || !type || !subtype) {
		return {
			...DEFAULT_CONTENT_TYPE,
			parameters: { ...DEFAULT_CONTENT_TYPE.parameters, ...parameters },
		};
	}
	return { mediaType: `${type}/${subtype}`, type, subtype, parameters };
}

/** Parses a `Content-Disposition` value (RFC 2183). */
export function parseContentDisposition(value: string): ContentDisposition {
	const { head, parameters } = splitValue(value);
	return {
		type: head
			.map((token) => token.value)
			.join('')
			.toLowerCase(),
		parameters,
	};
}

/** How much of a value one parameter section carries, so a folded line stays short. */
const SECTION = 60;

const ATTRIBUTE_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/**
 * A parameter as written: `name="value"` when the value is short ASCII;
 * RFC 2231 continuations (`name*0="…"; name*1="…"`) when it is long; and
 * `name*0*=utf-8''…` percent-encoded sections when it is not ASCII. No
 * section is longer than 60 characters, so a folded header keeps its lines
 * within 78.
 */
export function formatParameter(name: string, value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) {
		const quote = (text: string) => `"${text.replace(/(["\\])/g, '\\$1')}"`;
		if (value.length <= SECTION) return `${name}=${quote(value)}`;
		const sections: string[] = [];
		for (let i = 0; i < value.length; i += SECTION) {
			sections.push(
				`${name}*${sections.length}=${quote(value.slice(i, i + SECTION))}`,
			);
		}
		return sections.join('; ');
	}
	const pieces: string[] = [''];
	for (const char of value) {
		const encoded = [...new TextEncoder().encode(char)]
			.map((byte) => {
				const c = String.fromCharCode(byte);
				return ATTRIBUTE_CHAR.test(c)
					? c
					: `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
			})
			.join('');
		// A character's bytes stay in one section, for readers that decode each
		// on its own; a section is shorter than an ASCII one, since the first
		// also carries `utf-8''`.
		if (
			(pieces[pieces.length - 1] as string).length + encoded.length >
			SECTION - 12
		)
			pieces.push('');
		pieces[pieces.length - 1] += encoded;
	}
	if (pieces.length === 1) return `${name}*=utf-8''${pieces[0]}`;
	return pieces
		.map((piece, i) => `${name}*${i}*=${i === 0 ? "utf-8''" : ''}${piece}`)
		.join('; ');
}
