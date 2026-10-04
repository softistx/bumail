import { base64url } from '../encoding';
import { AcmeError } from '../errors';
import { algorithmOf, expectType, MIN_RSA_BITS } from '../keys/algorithm';

/**
 * A public key as a JWK (RFC 7517) with its required members only, as the
 * `jwk` of a JWS header carries it and RFC 7638 hashes it.
 */
export type PublicJwk =
	| { kty: 'EC'; crv: 'P-256'; x: string; y: string }
	| { kty: 'RSA'; n: string; e: string };

/** The public key's JWK, with nothing but its required members. */
export async function publicJwk(publicKey: CryptoKey): Promise<PublicJwk> {
	return await jwkOf(publicKey, 'publicJwk(): the key');
}

/** `publicJwk`, naming the caller and argument in its errors. */
export async function jwkOf(
	publicKey: CryptoKey,
	where: string,
): Promise<PublicJwk> {
	algorithmOf(publicKey, where);
	expectType(publicKey, 'public', where);
	return requiredMembers(
		await crypto.subtle.exportKey('jwk', publicKey),
		where,
	);
}

function requiredMembers(jwk: JsonWebKey, where: string): PublicJwk {
	const text = (name: 'x' | 'y' | 'n' | 'e'): string => {
		const value = jwk[name];
		if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
			throw new AcmeError(
				'INVALID_KEY',
				`${where} has no base64url "${name}" member`,
			);
		}
		return value;
	};
	if (jwk.kty === 'EC') {
		if (jwk.crv !== 'P-256') {
			throw new AcmeError(
				'INVALID_KEY',
				`${where} is an EC key on ${JSON.stringify(jwk.crv)}; only P-256 is supported`,
			);
		}
		return { kty: 'EC', crv: 'P-256', x: text('x'), y: text('y') };
	}
	if (jwk.kty === 'RSA') {
		const n = text('n');
		const bits = Buffer.from(n, 'base64url').length * 8;
		if (bits < MIN_RSA_BITS) {
			throw new AcmeError(
				'INVALID_KEY',
				`${where} is an RSA key of ${bits} bits; at least ${MIN_RSA_BITS} are needed`,
			);
		}
		return { kty: 'RSA', n, e: text('e') };
	}
	throw new AcmeError(
		'INVALID_KEY',
		`${where} has kty ${JSON.stringify(jwk.kty)}; only "EC" and "RSA" are supported`,
	);
}

/**
 * The JWK SHA-256 thumbprint (RFC 7638), base64url: SHA-256 over the JSON
 * of the key's required members, in lexicographic order, with no white
 * space. It takes a public `CryptoKey` or a JWK object; members a JWK has
 * beyond the required ones (`alg`, `kid`, `use`) are left out, as §3.2
 * says.
 */
export async function jwkThumbprint(
	key: CryptoKey | JsonWebKey,
): Promise<string> {
	const where = 'jwkThumbprint(): the key';
	const jwk =
		key instanceof CryptoKey
			? await jwkOf(key, where)
			: requiredMembers(objectOf(key, where), where);
	const canonical =
		jwk.kty === 'EC'
			? `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
			: `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	);
	return base64url(new Uint8Array(digest));
}

function objectOf(key: unknown, where: string): JsonWebKey {
	if (typeof key !== 'object' || key === null || Array.isArray(key)) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where} must be a public CryptoKey or a JWK object`,
		);
	}
	return key as JsonWebKey;
}
