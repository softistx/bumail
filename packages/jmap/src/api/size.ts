/**
 * The bytes `JSON.stringify(value)` would take, counted by walking the
 * value, and abandoned once past `max`: `max + 1` then, so measuring a
 * huge value costs no more than measuring `max` bytes of it. Strings are
 * counted in UTF-8 with their quotes, escapes left out.
 */
export function jsonSize(value: unknown, max: number): number {
	let size = 0;
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		if (size > max) return max + 1;
		const item = stack.pop();
		if (typeof item === 'string') size += Buffer.byteLength(item) + 2;
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
				size += Buffer.byteLength(key) + 3;
				stack.push(one);
			}
		}
	}
	return size > max ? max + 1 : size;
}
