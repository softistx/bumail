/**
 * A small, strict DER reader, for specs only: it reads back what the
 * writer and `createCsr` produce, independently of them, so a spec checks
 * the structure rather than trusting the code that built it. Definite,
 * minimal lengths and one-byte tags only; anything else throws.
 */

export interface DerNode {
	/** The whole tag byte: class, constructed bit and number. */
	tag: number;
	constructed: boolean;
	/** The content octets. */
	content: Uint8Array;
	/** Tag, length and content, as they were read. */
	raw: Uint8Array;
	/** The elements inside, for a constructed one. */
	children: DerNode[];
}

/** Reads one element, which must span the whole input. */
export function readDer(bytes: Uint8Array): DerNode {
	const [node, end] = readAt(bytes, 0);
	if (end !== bytes.length) {
		throw new Error(`DER: ${bytes.length - end} bytes after the element`);
	}
	return node;
}

function readAt(bytes: Uint8Array, start: number): [DerNode, number] {
	const tag = bytes[start];
	if (tag === undefined) throw new Error('DER: no tag');
	if ((tag & 0x1f) === 0x1f) throw new Error('DER: a multi-byte tag');
	let at = start + 1;
	const first = bytes[at++];
	if (first === undefined) throw new Error('DER: no length');
	let length = first;
	if (first & 0x80) {
		const count = first & 0x7f;
		if (count === 0) throw new Error('DER: an indefinite length');
		length = 0;
		for (let i = 0; i < count; i++) {
			const byte = bytes[at++];
			if (byte === undefined) throw new Error('DER: a cut length');
			if (i === 0 && byte === 0) throw new Error('DER: a length not minimal');
			length = length * 256 + byte;
		}
		if (length < 0x80) throw new Error('DER: a long length under 128');
	}
	const end = at + length;
	if (end > bytes.length) throw new Error('DER: content past the end');
	const content = bytes.subarray(at, end);
	const constructed = (tag & 0x20) !== 0;
	const children: DerNode[] = [];
	if (constructed) {
		let inner = 0;
		while (inner < content.length) {
			const [child, next] = readAt(content, inner);
			children.push(child);
			inner = next;
		}
	}
	return [
		{ tag, constructed, content, raw: bytes.subarray(start, end), children },
		end,
	];
}

/** The child at `index`, failing the spec when there is none. */
export function child(node: DerNode, index: number): DerNode {
	const found = node.children[index];
	if (!found) throw new Error(`DER: no element ${index} in tag ${node.tag}`);
	return found;
}

/** An OBJECT IDENTIFIER's dotted form. */
export function readOid(node: DerNode): string {
	if (node.tag !== 0x06) throw new Error(`DER: tag ${node.tag} is not an OID`);
	const arcs: bigint[] = [];
	let value = 0n;
	for (const byte of node.content) {
		value = (value << 7n) | BigInt(byte & 0x7f);
		if (!(byte & 0x80)) {
			arcs.push(value);
			value = 0n;
		}
	}
	const [first = 0n, ...rest] = arcs;
	const head =
		first < 40n
			? [0n, first]
			: first < 80n
				? [1n, first - 40n]
				: [2n, first - 80n];
	return [...head, ...rest].join('.');
}

/** A non-negative INTEGER, checking it is minimally encoded. */
export function readInteger(node: DerNode): bigint {
	if (node.tag !== 0x02) throw new Error(`DER: tag ${node.tag} is not INTEGER`);
	const bytes = node.content;
	if (bytes.length === 0) throw new Error('DER: an empty INTEGER');
	const [a = 0, b = 0] = bytes;
	if (bytes.length > 1 && a === 0 && !(b & 0x80)) {
		throw new Error('DER: an INTEGER with a needless leading zero');
	}
	if (a & 0x80) throw new Error('DER: a negative INTEGER');
	return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

/** The text of a string element. */
export function readText(node: DerNode): string {
	return new TextDecoder().decode(node.content);
}

/**
 * A DER `ECDSA-Sig-Value` as the P1363 `r‖s` Web Crypto verifies, each
 * half `size` bytes.
 */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
	const value = readDer(der);
	if (value.tag !== 0x30 || value.children.length !== 2) {
		throw new Error('DER: not an ECDSA-Sig-Value');
	}
	const out = new Uint8Array(size * 2);
	value.children.forEach((part, i) => {
		let hex = readInteger(part).toString(16);
		if (hex.length % 2) hex = `0${hex}`;
		const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
		if (bytes.length > size) throw new Error('DER: an integer too large');
		out.set(bytes, i * size + size - bytes.length);
	});
	return out;
}
