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
 * ECDSA on P-256, or RSASSA-PKCS1-v1_5 with SHA-256 of at least 2048 bits.
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
		if ((algorithm.modulusLength ?? 0) < MIN_RSA_BITS) {
			throw new AcmeError(
				'INVALID_KEY',
				`${where} is an RSA key of ${algorithm.modulusLength} bits; at least ${MIN_RSA_BITS} are needed`,
			);
		}
		return 'RS256';
	}
	throw new AcmeError(
		'INVALID_KEY',
		`${where} is ${describe(algorithm)}; only ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 are supported`,
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
export function keyPairOf(keyPair: unknown, where: string): JwsAlgorithm {
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
	return algorithm;
}
