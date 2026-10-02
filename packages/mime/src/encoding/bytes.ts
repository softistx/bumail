/** Two byte arrays end to end; either one itself when the other is empty. */
export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** Byte arrays end to end, always a new array. */
export function join(chunks: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(
		chunks.reduce((sum, chunk) => sum + chunk.length, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** Whether text holds a control character other than TAB: U+0000 to U+001F, U+007F. */
export function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
	}
	return false;
}
