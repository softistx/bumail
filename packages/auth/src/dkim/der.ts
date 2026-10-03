/** Just enough DER to wrap the key encodings DKIM meets into the ones Web Crypto imports. */

function lengthOf(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256);
	}
	return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
	const head = [tag, ...lengthOf(content.length)];
	const out = new Uint8Array(head.length + content.length);
	out.set(head);
	out.set(content, head.length);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const SEQUENCE = 0x30;
/** AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }. */
const RSA_ALGORITHM = Uint8Array.from([
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
	0x05, 0x00,
]);
/** AlgorithmIdentifier { id-Ed25519 (1.3.101.112) }. */
const ED25519_ALGORITHM = Uint8Array.from([
	0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
]);
const VERSION_0 = Uint8Array.from([0x02, 0x01, 0x00]);

/** An RSAPublicKey (PKCS #1), which RFC 6376 §3.6.1 names for `p=`, as the SubjectPublicKeyInfo Web Crypto imports. */
export function spkiOfRsaPublicKey(pkcs1: Uint8Array): Uint8Array {
	return der(
		SEQUENCE,
		concat(RSA_ALGORITHM, der(0x03, concat(Uint8Array.of(0), pkcs1))),
	);
}

/** An RSAPrivateKey (PKCS #1, "BEGIN RSA PRIVATE KEY") as the PKCS #8 Web Crypto imports. */
export function pkcs8OfRsaPrivateKey(pkcs1: Uint8Array): Uint8Array {
	return der(SEQUENCE, concat(VERSION_0, RSA_ALGORITHM, der(0x04, pkcs1)));
}

/** A 32-byte Ed25519 private key (RFC 8032's seed, as RFC 8463 prints it) as PKCS #8. */
export function pkcs8OfEd25519Seed(seed: Uint8Array): Uint8Array {
	return der(
		SEQUENCE,
		concat(VERSION_0, ED25519_ALGORITHM, der(0x04, der(0x04, seed))),
	);
}
