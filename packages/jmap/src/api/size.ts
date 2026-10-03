/**
 * The bytes `JSON.stringify(value)` would take, counted by walking the
 * value, and abandoned once past `max`: `max + 1` then, so measuring a
 * huge value costs no more than measuring `max` bytes of it. Strings are
 * counted in UTF-8 with their quotes and escapes.
 */
export function jsonSize(value: unknown, max: number): number {
	let size = 0;
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		if (size > max) return max + 1;
		const item = stack.pop();
		if (typeof item === 'string') size += stringSize(item);
		else if (typeof item === 'number') size += String(item).length;
		else if (typeof item === 'boolean') size += item ? 4 : 5;
		else if (item === null) size += 4;
		else if (Array.isArray(item)) {
			size += 2 + Math.max(0, item.length - 1);
			for (const one of item) stack.push(one === undefined ? null : one);
		} else if (typeof item === 'object') {
			const entries = Object.entries(item as object).filter(
				([, one]) => one !== undefined && typeof one !== 'function',
			);
			size += 2 + Math.max(0, entries.length - 1);
			for (const [key, one] of entries) {
				size += stringSize(key) + 1;
				stack.push(one);
			}
		}
	}
	return size > max ? max + 1 : size;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters JSON escapes
const ESCAPED = /[\u0000-\u001f"\\\ud800-\udfff]/;
const SHORT = new Set([0x22, 0x5c, 0x08, 0x0c, 0x0a, 0x0d, 0x09]);

/**
 * The bytes of `JSON.stringify(text)`: its UTF-8 and two quotes, plus 1 for
 * each short escape (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`), 5 for
 * another control character (`\u00XX`, 6 bytes for 1), and 3 for a lone
 * surrogate (`\udXXX`, 6 bytes where UTF-8 counts 3).
 */
function stringSize(text: string): number {
	const size = Buffer.byteLength(text) + 2;
	if (!ESCAPED.test(text)) return size;
	let extra = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (SHORT.has(code)) extra += 1;
		else if (code < 0x20) extra += 5;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
			else extra += 3;
		} else if (code >= 0xdc00 && code <= 0xdfff) extra += 3;
	}
	return size + extra;
}
