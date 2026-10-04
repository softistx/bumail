import { pem, pemBytes } from '../encoding';
import { AcmeError } from '../errors';
import {
	algorithmOf,
	ECDSA_P256,
	expectType,
	MIN_RSA_BITS,
	RSA_SHA256,
} from './algorithm';

/** The keys `generateKeyPair` makes. */
export type KeyType = 'P-256' | 'RSA-2048';

/**
 * A new key pair, for an ACME account or for a certificate: ECDSA on P-256
 * (the default, as a certificate's key) or RSA of 2048 bits with
 * RSASSA-PKCS1-v1_5 and SHA-256. Its private key is extractable, so
 * `exportPrivateKeyPem` can write it out.
 */
export async function generateKeyPair(
	type: KeyType = 'P-256',
): Promise<CryptoKeyPair> {
	if (type === 'P-256') {
		return await crypto.subtle.generateKey(ECDSA_P256, true, [
			'sign',
			'verify',
		]);
	}
	if (type === 'RSA-2048') {
		return await crypto.subtle.generateKey(
			{
				...RSA_SHA256,
				modulusLength: MIN_RSA_BITS,
				publicExponent: Uint8Array.of(1, 0, 1),
			},
			true,
			['sign', 'verify'],
		);
	}
	throw new AcmeError(
		'INVALID_OPTION',
		`generateKeyPair(): the type is 'P-256' or 'RSA-2048', not ${JSON.stringify(type)}`,
	);
}

/**
 * The private key as PKCS #8 in PEM (`-----BEGIN PRIVATE KEY-----`), the
 * form Bun's and Node's TLS take as `key`, and `importKeyPairPem` reads
 * back. The key must be extractable.
 */
export async function exportPrivateKeyPem(
	privateKey: CryptoKey,
): Promise<string> {
	const where = 'exportPrivateKeyPem(): the key';
	algorithmOf(privateKey, where);
	expectType(privateKey, 'private', where);
	if (!privateKey.extractable) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where} is not extractable; generate or import it with extractable: true`,
		);
	}
	const der = await crypto.subtle.exportKey('pkcs8', privateKey);
	return pem('PRIVATE KEY', new Uint8Array(der));
}

/** Options of `importKeyPairPem`. */
export interface ImportKeyPairOptions {
	/** Whether the imported private key can be exported again. Defaults to false. */
	extractable?: boolean;
}

/**
 * A key pair from a PKCS #8 PEM private key (`-----BEGIN PRIVATE KEY-----`)
 * of ECDSA P-256 or RSA, as `exportPrivateKeyPem` writes it: the private
 * key for signing, and its public key, derived from it, for the JWK and the
 * CSR. Any other key, or a PEM that holds none, is `INVALID_KEY`.
 */
export async function importKeyPairPem(
	text: string,
	options: ImportKeyPairOptions = {},
): Promise<CryptoKeyPair> {
	const where = 'importKeyPairPem()';
	if (typeof text !== 'string') {
		throw new AcmeError('INVALID_KEY', `${where}: the PEM must be a string`);
	}
	const extractable = options.extractable ?? false;
	if (typeof extractable !== 'boolean') {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: extractable must be a boolean`,
		);
	}
	const der = pemBytes(text, 'PRIVATE KEY');
	if (der === undefined) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where}: expected a PEM PRIVATE KEY block (PKCS #8)`,
		);
	}
	for (const algorithm of [ECDSA_P256, RSA_SHA256]) {
		let full: CryptoKey;
		try {
			full = await crypto.subtle.importKey(
				'pkcs8',
				der as BufferSource,
				algorithm,
				true,
				['sign'],
			);
		} catch {
			continue;
		}
		algorithmOf(full, `${where}: the key`);
		const jwk = await crypto.subtle.exportKey('jwk', full);
		const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = jwk;
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			{ ...pub, key_ops: ['verify'] },
			algorithm,
			true,
			['verify'],
		);
		const privateKey = extractable
			? full
			: await crypto.subtle.importKey(
					'pkcs8',
					der as BufferSource,
					algorithm,
					false,
					['sign'],
				);
		return { publicKey, privateKey };
	}
	throw new AcmeError(
		'INVALID_KEY',
		`${where}: the PRIVATE KEY is neither an ECDSA P-256 nor an RSA key`,
	);
}
