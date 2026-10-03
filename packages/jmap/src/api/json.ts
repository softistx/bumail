/** What a JSON text breaks, found before it is parsed. */
export type JsonExcess = 'depth' | 'tokens';

const isSpace = (code: number) =>
	code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** Where the string that opens at `start` closes; its length when it never does. */
function stringEnd(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 0x5c) i += 2;
		else if (code === 0x22) return i + 1;
		else i++;
	}
	return i;
}

/** Where the number or literal that starts at `start` ends. */
function scalarEnd(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (
			isSpace(code) ||
			code === 0x2c ||
			code === 0x3a ||
			code === 0x5d ||
			code === 0x7d
		) {
			break;
		}
		i++;
	}
	return Math.max(i, start + 1);
}

/**
 * How deep a JSON text nests and how many tokens it holds — each bracket
 * opened, each key and each value — counted in one pass before
 * `JSON.parse` sees it, so a text that would cost the parser too much is
 * refused unparsed. A text that is not JSON is left to `JSON.parse`.
 */
export function jsonExcess(
	text: string,
	maxDepth: number,
	maxTokens: number,
): JsonExcess | undefined {
	let depth = 0;
	let tokens = 0;
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 0x7b || code === 0x5b) {
			depth++;
			tokens++;
			if (depth > maxDepth) return 'depth';
			i++;
		} else if (code === 0x7d || code === 0x5d) {
			depth--;
			i++;
		} else if (code === 0x22) {
			tokens++;
			i = stringEnd(text, i);
		} else if (isSpace(code) || code === 0x2c || code === 0x3a) {
			i++;
		} else {
			tokens++;
			i = scalarEnd(text, i);
		}
		if (tokens > maxTokens) return 'tokens';
	}
	return undefined;
}
