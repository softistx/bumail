import { AcmeError } from '../errors';

/** The JWS algorithms this package signs with (RFC 7518 §3.1). */
export type JwsAlgorithm = 'ES256' | 'RS256';

export const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const RSA_SHA256 = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: 'SHA-256',
} as const;
/** What `crypto.subtle.sign` and `verify` take for each algorithm. */
export const SIGN_PARAMS = {
	ES256: { name: 'ECDSA', hash: 'SHA-256' },
	RS256: { name: 'RSASSA-PKCS1-v1_5' },
} as const;

/** CAs refuse a smaller RSA key; Let's Encrypt takes 2048 to 4096 bits. */
export const MIN_RSA_BITS = 2048;

/**
 * The JWS algorithm of a key, refusing any other with `INVALID_KEY`:
 * ECDSA on P-256, or RSASSA-PKCS1-v1_5 with SHA-256; an RSA key's size
 * and exponent are checked by `checkRsaKey`, which is async.
 * `where` names the caller and the argument, for the message.
 */
export function algorithmOf(key: unknown, where: string): JwsAlgorithm {
	if (!(key instanceof CryptoKey)) {
		throw new AcmeError('INVALID_KEY', `${where} must be a CryptoKey`);
	}
	const algorithm = key.algorithm as Partial<
		EcKeyAlgorithm & RsaHashedKeyAlgorithm
	>;
	if (algorithm.name === 'ECDSA' && algorithm.namedCurve === 'P-256') {
		return 'ES256';
	}
	if (
		algorithm.name === 'RSASSA-PKCS1-v1_5' &&
		algorithm.hash?.name === 'SHA-256'
	) {
		return 'RS256';
	}
	throw new AcmeError(
		'INVALID_KEY',
		`${where} is ${describe(algorithm)}; only ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 are supported`,
	);
}

/** The modulus sizes Let's Encrypt takes. */
export const RSA_BITS = [2048, 3072, 4096] as const;

/**
 * Refuses an RSA key a CA would: a modulus of a size other than 2048,
 * 3072 or 4096 bits, or a public exponent other than 65537.
 */
export function checkRsa(
	bits: number,
	exponent: Uint8Array,
	where: string,
): void {
	if (!(RSA_BITS as readonly number[]).includes(bits)) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where} is an RSA key of ${bits} bits; only 2048, 3072 and 4096 are supported`,
		);
	}
	let start = 0;
	while (start < exponent.length && exponent[start] === 0) start++;
	const e = exponent.subarray(start);
	if (e.length !== 3 || e[0] !== 1 || e[1] !== 0 || e[2] !== 1) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where} is an RSA key whose public exponent is not 65537`,
		);
	}
}

/** The length in bits of an unsigned big-endian integer, its leading zeros left out. */
export function bitLength(bytes: Uint8Array): number {
	let start = 0;
	while (start < bytes.length && bytes[start] === 0) start++;
	const first = bytes[start];
	if (first === undefined) return 0;
	return (bytes.length - start - 1) * 8 + (32 - Math.clz32(first));
}

/**
 * Refuses an RSA key outside Let's Encrypt's policy, measuring its modulus
 * from the key's JWK `n`: Web Crypto's `modulusLength` is a byte count
 * times 8 in Bun, so a 2047-bit key reads as 2048 and a 2049-bit one as
 * 2056. A key that cannot be exported (a private key imported as not
 * extractable, as `importKeyPairPem` does by default) falls back to
 * `modulusLength`, and is measured to the byte only: `keyPairOf` checks
 * both halves of a pair, so the public key, always exportable when Web
 * Crypto made it, is measured exactly. Other keys pass.
 */
export async function checkRsaKey(
	key: CryptoKey,
	where: string,
): Promise<void> {
	if (key.algorithm.name !== 'RSASSA-PKCS1-v1_5') return;
	let jwk: JsonWebKey | undefined;
	try {
		jwk = await crypto.subtle.exportKey('jwk', key);
	} catch {
		jwk = undefined;
	}
	if (typeof jwk?.n === 'string' && typeof jwk.e === 'string') {
		checkRsaJwk(jwk.n, jwk.e, where);
		return;
	}
	const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
	checkRsa(algorithm.modulusLength, algorithm.publicExponent, where);
}

/** `checkRsa` on a JWK's base64url `n` and `e`. */
export function checkRsaJwk(n: string, e: string, where: string): void {
	checkRsa(
		bitLength(new Uint8Array(Buffer.from(n, 'base64url'))),
		new Uint8Array(Buffer.from(e, 'base64url')),
		where,
	);
}

function describe(
	algorithm: Partial<EcKeyAlgorithm & RsaHashedKeyAlgorithm>,
): string {
	const detail = algorithm.namedCurve ?? algorithm.hash?.name;
	return detail ? `${algorithm.name} ${detail}` : `${algorithm.name}`;
}

/** Refuses a key of the wrong type (`public` or `private`) for its role. */
export function expectType(
	key: CryptoKey,
	type: 'public' | 'private',
	where: string,
): void {
	if (key.type !== type) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where} must be a ${type} key, not a ${key.type} one`,
		);
	}
}

/** The key pair given, both halves checked, and its algorithm. */
export async function keyPairOf(
	keyPair: unknown,
	where: string,
): Promise<JwsAlgorithm> {
	const pair = keyPair as Partial<CryptoKeyPair> | null | undefined;
	if (typeof pair !== 'object' || pair === null) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where} must be a CryptoKeyPair ({ publicKey, privateKey })`,
		);
	}
	const algorithm = algorithmOf(pair.privateKey, `${where}.privateKey`);
	const publicAlgorithm = algorithmOf(pair.publicKey, `${where}.publicKey`);
	expectType(pair.privateKey as CryptoKey, 'private', `${where}.privateKey`);
	expectType(pair.publicKey as CryptoKey, 'public', `${where}.publicKey`);
	if (publicAlgorithm !== algorithm) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where}'s public and private keys are not of the same algorithm`,
		);
	}
	await checkRsaKey(pair.publicKey as CryptoKey, `${where}.publicKey`);
	await checkRsaKey(pair.privateKey as CryptoKey, `${where}.privateKey`);
	return algorithm;
}
