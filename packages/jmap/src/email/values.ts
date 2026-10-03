import type { Args } from '../api/args';
import type { Part } from './parse';
import { partIdOf, walk } from './parse';
import { type Bodies, textOf } from './structure';

/** Which body values Email/get returns, and how long each may be. */
export interface ValueOptions {
	readonly text: boolean;
	readonly html: boolean;
	readonly all: boolean;
	/** Bytes of UTF-8 each value is cut to. */
	readonly max: number;
}

/** Text cut to at most `max` bytes of UTF-8, never inside a character. */
export function cutUtf8(
	text: string,
	max: number,
): { value: string; cut: boolean } {
	if (text.length * 3 <= max) return { value: text, cut: false };
	const buffer = new Uint8Array(max);
	const { read } = new TextEncoder().encodeInto(text, buffer);
	return { value: text.slice(0, read), cut: read < text.length };
}

/** RFC 8621 §4.1.4 `bodyValues`: the text of the parts asked for, by partId. */
export function bodyValues(
	root: Part,
	bodies: Bodies,
	options: ValueOptions,
): Args {
	const parts = new Set<Part>();
	if (options.all) {
		for (const part of walk(root))
			if (part.contentType.type === 'text') parts.add(part);
	}
	if (options.text) for (const part of bodies.textBody) parts.add(part);
	if (options.html) for (const part of bodies.htmlBody) parts.add(part);
	const values: Args = {};
	for (const part of parts) {
		if (part.contentType.type !== 'text') continue;
		const { text, problem } = textOf(part);
		const { value, cut } = cutUtf8(text, options.max);
		values[partIdOf(part)] = {
			value,
			isEncodingProblem: problem,
			isTruncated: cut || part.keptSize < part.size,
		};
	}
	return values;
}

const ENTITIES: Readonly<Record<string, string>> = {
	'&nbsp;': ' ',
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
};

/**
 * Text of an HTML body, for a preview or a search: tags, scripts and
 * styles dropped, a few entities read. One pass, never a backtracking
 * pattern, so a hostile body costs time in proportion to its size.
 */
export function htmlText(html: string): string {
	// ASCII letters only: a lowercase of the same length, so an index in
	// `lower` is the same index in `html` (`İ` lowercases to two units).
	const lower = html.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
	let out = '';
	let i = 0;
	while (i < html.length) {
		const open = html.indexOf('<', i);
		if (open < 0) {
			out += html.slice(i);
			break;
		}
		out += `${html.slice(i, open)} `;
		const close = html.indexOf('>', open);
		if (close < 0) break;
		const tag = /^<(script|style)\b/.exec(lower.slice(open, open + 8))?.[1];
		i = close + 1;
		if (tag !== undefined) {
			const end = lower.indexOf(`</${tag}`, i);
			if (end < 0) break;
			i = end;
		}
	}
	return out.replace(
		/&(nbsp|amp|lt|gt|quot|#39);/gi,
		(entity) => ENTITIES[entity.toLowerCase()] ?? entity,
	);
}

/** RFC 8621 §4.1.4 `preview`: up to 256 characters of the first text body, white space collapsed. */
export function previewOf(bodies: Bodies): string {
	const part = bodies.textBody.find((one) => one.contentType.type === 'text');
	if (part === undefined) return '';
	const { text } = textOf(part);
	const plain =
		part.contentType.subtype.toLowerCase() === 'html' ? htmlText(text) : text;
	return [...plain.replace(/\s+/g, ' ').trim()].slice(0, 256).join('');
}
