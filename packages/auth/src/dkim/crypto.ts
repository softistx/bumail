import { spkiOfRsaPublicKey } from './der';
import type { DkimAlgorithm } from './result';

/** The key types DKIM key records name in `k=`. */
export type DkimKeyType = 'rsa' | 'ed25519';

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** The key type an algorithm signs with. */
export function keyTypeOf(algorithm: DkimAlgorithm): DkimKeyType {
	return algorithm === 'rsa-sha256' ? 'rsa' : 'ed25519';
}

async function tryImport(
	format: 'spki' | 'raw',
	bytes: Uint8Array,
	algorithm: typeof RSA | { name: 'Ed25519' },
): Promise<CryptoKey | undefined> {
	try {
		return await crypto.subtle.importKey(
			format,
			bytes as BufferSource,
			algorithm,
			false,
			['verify'],
		);
	} catch {
		return undefined;
	}
}

/**
 * The public key in a `p=`: for RSA a SubjectPublicKeyInfo, which is what
 * keys are published as, or the bare RSAPublicKey RFC 6376 §3.6.1 names;
 * for Ed25519 the 32 raw bytes (RFC 8463 §4). `undefined` when the bytes
 * are not such a key.
 */
export async function importPublicKey(
	type: DkimKeyType,
	bytes: Uint8Array,
): Promise<CryptoKey | undefined> {
	if (type === 'ed25519') {
		return bytes.length === 32
			? tryImport('raw', bytes, { name: 'Ed25519' })
			: undefined;
	}
	return (
		(await tryImport('spki', bytes, RSA)) ??
		(await tryImport('spki', spkiOfRsaPublicKey(bytes), RSA))
	);
}

/** The modulus length of an RSA key, in bits. */
export function rsaBits(key: CryptoKey): number {
	return (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest('SHA-256', data as BufferSource),
	);
}

/**
 * Whether `signature` signs the canonical header `data`: RSASSA-PKCS1-v1_5
 * over SHA-256 for rsa-sha256 (RFC 6376 §3.3.1), PureEdDSA over the
 * SHA-256 of the data for ed25519-sha256 (RFC 8463 §3). Never throws.
 */
export async function verifyData(
	algorithm: DkimAlgorithm,
	key: CryptoKey,
	data: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		if (algorithm === 'rsa-sha256') {
			return await crypto.subtle.verify(
				RSA,
				key,
				signature as BufferSource,
				data as BufferSource,
			);
		}
		return await crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			signature as BufferSource,
			(await sha256(data)) as BufferSource,
		);
	} catch {
		return false;
	}
}

/** Signs the canonical header `data` as `verifyData` checks it. */
export async function signData(
	algorithm: DkimAlgorithm,
	key: CryptoKey,
	data: Uint8Array,
): Promise<Uint8Array> {
	const signed =
		algorithm === 'rsa-sha256'
			? await crypto.subtle.sign(RSA, key, data as BufferSource)
			: await crypto.subtle.sign(
					{ name: 'Ed25519' },
					key,
					(await sha256(data)) as BufferSource,
				);
	return new Uint8Array(signed);
}
