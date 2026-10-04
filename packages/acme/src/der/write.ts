/**
 * A minimal DER writer (ITU-T X.690): just the types a PKCS #10 request
 * and its signature need. Each function returns one complete encoding,
 * tag, length and content, and the constructed ones take encodings.
 *
 * It is internal: what it is given is built by this package, so a bad
 * argument is a bug here, and throws a `RangeError` rather than an
 * `AcmeError`.
 */

const TAG = {
	integer: 0x02,
	bitString: 0x03,
	octetString: 0x04,
	null: 0x05,
	oid: 0x06,
	utf8String: 0x0c,
	printableString: 0x13,
	ia5String: 0x16,
	sequence: 0x30,
	set: 0x31,
} as const;

/** The definite length of X.690 §8.1.3: short below 128, long otherwise. */
export function encodeLength(length: number): Uint8Array {
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new RangeError(`DER: a length is a natural number, not ${length}`);
	}
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256);
	}
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** One element: a tag of one byte (low tag numbers only), its length, its content. */
export function element(tag: number, content: Uint8Array): Uint8Array {
	if (
		!Number.isInteger(tag) ||
		tag < 0 ||
		tag > 0xff ||
		(tag & 0x1f) === 0x1f
	) {
		throw new RangeError(`DER: ${tag} is not a one-byte tag`);
	}
	return concat([Uint8Array.of(tag), encodeLength(content.length), content]);
}

export function sequence(...children: Uint8Array[]): Uint8Array {
	return element(TAG.sequence, concat(children));
}

/**
 * A SET OF: DER sorts its elements by their encodings, compared as octet
 * strings with the shorter one padded at its end (X.690 §11.6).
 */
export function set(...children: Uint8Array[]): Uint8Array {
	const sorted = [...children].sort(compareEncodings);
	return element(TAG.set, concat(sorted));
}

function compareEncodings(a: Uint8Array, b: Uint8Array): number {
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * A non-negative INTEGER, from a number, a bigint, or the unsigned
 * big-endian bytes of its magnitude (as an ECDSA `r` or `s`): leading
 * zeros are trimmed, and one `0x00` is put back when the first byte left
 * has its high bit set, so the value never reads as negative (X.690
 * §8.3.2).
 */
export function integer(value: number | bigint | Uint8Array): Uint8Array {
	const bytes = value instanceof Uint8Array ? value : magnitude(value);
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	const trimmed = bytes.length === 0 ? Uint8Array.of(0) : bytes.subarray(start);
	const high = (trimmed[0] ?? 0) & 0x80;
	return element(
		TAG.integer,
		high ? concat([Uint8Array.of(0), trimmed]) : trimmed,
	);
}

function magnitude(value: number | bigint): Uint8Array {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) {
		throw new RangeError(`DER: ${value} is not a safe integer`);
	}
	let rest = BigInt(value);
	if (rest < 0n) {
		throw new RangeError(`DER: only non-negative integers, not ${value}`);
	}
	const bytes: number[] = [];
	do {
		bytes.unshift(Number(rest & 0xffn));
		rest >>= 8n;
	} while (rest > 0n);
	return Uint8Array.from(bytes);
}

/** An OBJECT IDENTIFIER from its dotted form (X.690 §8.19). */
export function oid(dotted: string): Uint8Array {
	const arcs = /^\d+(\.\d+)+$/.test(dotted)
		? dotted.split('.').map(BigInt)
		: undefined;
	const [first, second, ...rest] = arcs ?? [];
	if (
		first === undefined ||
		second === undefined ||
		first > 2n ||
		(first < 2n && second > 39n)
	) {
		throw new RangeError(`DER: "${dotted}" is not an object identifier`);
	}
	const content: number[] = [];
	for (const arc of [first * 40n + second, ...rest]) {
		const groups: number[] = [];
		let left = arc;
		do {
			groups.unshift(Number(left & 0x7fn));
			left >>= 7n;
		} while (left > 0n);
		for (let i = 0; i < groups.length - 1; i++) {
			groups[i] = (groups[i] ?? 0) | 0x80;
		}
		content.push(...groups);
	}
	return element(TAG.oid, Uint8Array.from(content));
}

export function utf8String(text: string): Uint8Array {
	return element(TAG.utf8String, new TextEncoder().encode(text));
}

/** A PrintableString: letters, digits, space and `'()+,-./:=?` only. */
export function printableString(text: string): Uint8Array {
	if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(text)) {
		throw new RangeError(`DER: "${text}" is not a PrintableString`);
	}
	return element(TAG.printableString, new TextEncoder().encode(text));
}

/** An IA5String: ASCII only. */
export function ia5String(text: string): Uint8Array {
	if (!/^\p{ASCII}*$/u.test(text)) {
		throw new RangeError(`DER: "${text}" is not an IA5String`);
	}
	return element(TAG.ia5String, new TextEncoder().encode(text));
}

/** A BIT STRING of whole bytes, unless `unusedBits` (0 to 7) says otherwise. */
export function bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
	if (
		!Number.isInteger(unusedBits) ||
		unusedBits < 0 ||
		unusedBits > 7 ||
		(bytes.length === 0 && unusedBits !== 0)
	) {
		throw new RangeError(`DER: ${unusedBits} unused bits cannot be`);
	}
	return element(TAG.bitString, concat([Uint8Array.of(unusedBits), bytes]));
}

export function octetString(bytes: Uint8Array): Uint8Array {
	return element(TAG.octetString, bytes);
}

export function nullValue(): Uint8Array {
	return Uint8Array.of(TAG.null, 0);
}

/** `[n] EXPLICIT`: a constructed context tag around the encodings given. */
export function explicit(n: number, ...children: Uint8Array[]): Uint8Array {
	return element(0xa0 | contextNumber(n), concat(children));
}

/**
 * `[n] IMPLICIT`: the encoding given with its tag replaced by the context
 * tag `n`, kept constructed if it was (a SET OF becomes `0xa0 | n`, an
 * IA5String `0x80 | n`).
 */
export function implicit(n: number, encoded: Uint8Array): Uint8Array {
	const tag = encoded[0];
	if (tag === undefined) throw new RangeError('DER: nothing to tag');
	const out = Uint8Array.from(encoded);
	out[0] = 0x80 | (tag & 0x20) | contextNumber(n);
	return out;
}

function contextNumber(n: number): number {
	if (!Number.isInteger(n) || n < 0 || n > 30) {
		throw new RangeError(`DER: [${n}] is not a low context tag`);
	}
	return n;
}
