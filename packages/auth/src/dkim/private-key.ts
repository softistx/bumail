import { AuthError } from '../errors';
import { pkcs8OfEd25519Seed, pkcs8OfRsaPrivateKey } from './der';
import { decodeBase64Strict, withoutFws } from './tags';

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const ED25519 = { name: 'Ed25519' } as const;

function invalid(message: string): AuthError {
	return new AuthError('INVALID_KEY', `importDkimPrivateKey(): ${message}`);
}

async function importPkcs8(
	bytes: Uint8Array,
	algorithm: typeof RSA | typeof ED25519,
): Promise<CryptoKey | undefined> {
	try {
		return await crypto.subtle.importKey(
			'pkcs8',
			bytes as BufferSource,
			algorithm,
			false,
			['sign'],
		);
	} catch {
		return undefined;
	}
}

function pemBody(text: string, label: string): Uint8Array {
	const match = new RegExp(
		`-----BEGIN ${label}-----([^-]*)-----END ${label}-----`,
	).exec(text);
	const bytes = decodeBase64Strict(withoutFws(match?.[1] ?? ''));
	if (bytes === undefined) throw invalid(`the ${label} block is not base64`);
	return bytes;
}

/**
 * A DKIM private key as a `CryptoKey` that `signDkim` signs with, from the
 * forms keys come in: a PEM `RSA PRIVATE KEY` (PKCS #1, as `openssl genrsa`
 * and `opendkim-genkey` write it), a PEM `PRIVATE KEY` (PKCS #8, RSA or
 * Ed25519), or a bare base64 Ed25519 private key of 32 bytes (as RFC 8463
 * prints one). The key is not extractable.
 */
export async function importDkimPrivateKey(text: string): Promise<CryptoKey> {
	if (typeof text !== 'string') throw invalid('the key must be a string');
	let key: CryptoKey | undefined;
	if (text.includes('-----BEGIN RSA PRIVATE KEY-----')) {
		key = await importPkcs8(
			pkcs8OfRsaPrivateKey(pemBody(text, 'RSA PRIVATE KEY')),
			RSA,
		);
	} else if (text.includes('-----BEGIN PRIVATE KEY-----')) {
		const bytes = pemBody(text, 'PRIVATE KEY');
		key =
			(await importPkcs8(bytes, RSA)) ?? (await importPkcs8(bytes, ED25519));
	} else {
		const seed = decodeBase64Strict(withoutFws(text));
		if (seed === undefined || seed.length !== 32) {
			throw invalid(
				'expected a PEM RSA PRIVATE KEY or PRIVATE KEY, or a base64 Ed25519 key of 32 bytes',
			);
		}
		key = await importPkcs8(pkcs8OfEd25519Seed(seed), ED25519);
	}
	if (key === undefined)
		throw invalid(
			'the key could not be imported as an RSA or Ed25519 private key',
		);
	return key;
}
