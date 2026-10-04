/**
 * Self-signed certificates for specs, built here rather than read from a
 * committed file, which would expire, or made by `openssl`, which a
 * machine may not have: an ECDSA P-256 key from Web Crypto, and a minimal
 * X.509 v3 certificate (RFC 5280) for it, DER-encoded by hand, its names
 * in a subjectAltName.
 */

const enc = new TextEncoder();

function length(n: number): number[] {
	if (n < 0x80) return [n];
	const bytes: number[] = [];
	for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
	return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
	return Uint8Array.from([tag, ...length(content.length), ...content]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(parts));

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes: Uint8Array): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	const trimmed = bytes.slice(start);
	const padded =
		(trimmed[0] ?? 0) & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed;
	return tlv(0x02, padded);
}

function oid(dotted: string): Uint8Array {
	const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
	const bytes = [40 * a + b];
	for (const arc of rest) {
		const sub = [arc & 0x7f];
		for (let n = arc >> 7; n > 0; n >>= 7) sub.unshift((n & 0x7f) | 0x80);
		bytes.push(...sub);
	}
	return tlv(0x06, Uint8Array.from(bytes));
}

function utcTime(date: Date): Uint8Array {
	const iso = date.toISOString();
	const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
	return tlv(0x17, enc.encode(text));
}

function name(cn: string): Uint8Array {
	return seq(set(seq(oid('2.5.4.3'), tlv(0x0c, enc.encode(cn)))));
}

function pem(label: string, der: Uint8Array): string {
	const base64 = Buffer.from(der).toString('base64');
	const lines = base64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface SelfSigned {
	/** The certificate, PEM. */
	readonly cert: string;
	/** Its private key, PKCS #8 PEM. */
	readonly key: string;
}

/**
 * A self-signed certificate for `names` (the first also its CN), valid
 * from `notBefore` (default a day ago) to `notAfter` (default in a day).
 */
export async function selfSigned(
	names: readonly string[],
	validity: { readonly notBefore?: Date; readonly notAfter?: Date } = {},
): Promise<SelfSigned> {
	const day = 24 * 60 * 60 * 1000;
	const notBefore = validity.notBefore ?? new Date(Date.now() - day);
	const notAfter = validity.notAfter ?? new Date(Date.now() + day);
	const pair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	);
	const spki = new Uint8Array(
		await crypto.subtle.exportKey('spki', pair.publicKey),
	);
	const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
	const subject = name(names[0] ?? 'localhost');
	// An IPv4 address is an iPAddress name, anything else a dNSName.
	const altNames = seq(
		...names.map((n) =>
			/^\d+\.\d+\.\d+\.\d+$/.test(n)
				? tlv(0x87, Uint8Array.from(n.split('.').map(Number)))
				: tlv(0x82, enc.encode(n)),
		),
	);
	const tbs = seq(
		tlv(0xa0, integer(Uint8Array.of(2))),
		integer(crypto.getRandomValues(new Uint8Array(16))),
		ecdsaWithSha256,
		subject,
		seq(utcTime(notBefore), utcTime(notAfter)),
		subject,
		spki,
		tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, altNames)))),
	);
	const p1363 = new Uint8Array(
		await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			pair.privateKey,
			// A copy on a plain ArrayBuffer, as Web Crypto's types ask.
			new Uint8Array(tbs),
		),
	);
	const signature = seq(integer(p1363.slice(0, 32)), integer(p1363.slice(32)));
	const der = seq(
		tbs,
		ecdsaWithSha256,
		tlv(0x03, concat([Uint8Array.of(0), signature])),
	);
	const pkcs8 = new Uint8Array(
		await crypto.subtle.exportKey('pkcs8', pair.privateKey),
	);
	return { cert: pem('CERTIFICATE', der), key: pem('PRIVATE KEY', pkcs8) };
}
