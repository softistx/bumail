import { base64url, isBase64url } from '../encoding';
import { AcmeError } from '../errors';
import { type JwsAlgorithm, keyPairOf, SIGN_PARAMS } from '../keys/algorithm';
import { jwkOf, type PublicJwk } from './jwk';

/** Options of `signJws`. */
export interface JwsOptions {
	/** The account key pair: the private key signs, the public one is the `jwk` when there is no `kid`. */
	keyPair: CryptoKeyPair;
	/** The `Replay-Nonce` the server gave last (RFC 8555 §6.5), base64url. */
	nonce: string;
	/** The URL the request is POSTed to, exactly (RFC 8555 §6.4); `https:` only. */
	url: string;
	/**
	 * The account URL, once the account exists: the header then carries
	 * `kid` instead of `jwk` (RFC 8555 §6.2). Only `newAccount` and
	 * `revokeCert` by the certificate's key go without one.
	 */
	kid?: string;
	/**
	 * The JSON payload. Left out, the request is a POST-as-GET (RFC 8555
	 * §6.3), whose payload is the empty string; `{}` is not the same, and is
	 * what a challenge is answered with.
	 */
	payload?: object;
}

/** A JWS in the flattened JSON serialization (RFC 7515 §7.2.2), the body ACME POSTs as `application/jose+json`. */
export interface FlattenedJws {
	protected: string;
	payload: string;
	signature: string;
}

/** The protected header of an ACME request (RFC 8555 §6.2). */
export type ProtectedHeader = {
	alg: JwsAlgorithm;
	nonce: string;
	url: string;
} & ({ jwk: PublicJwk; kid?: never } | { kid: string; jwk?: never });

/**
 * Signs an ACME request: the protected header `{ alg, nonce, url, jwk | kid }`,
 * the payload as base64url JSON (or `""` for POST-as-GET), and the
 * signature over `protected.payload`. ES256 signs with ECDSA P-256 and
 * SHA-256, its signature the 64 bytes of `r‖s` (RFC 7518 §3.4), not DER;
 * RS256 with RSASSA-PKCS1-v1_5 and SHA-256. Every part is base64url
 * without padding.
 */
export async function signJws(options: JwsOptions): Promise<FlattenedJws> {
	const where = 'signJws()';
	if (typeof options !== 'object' || options === null) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: options must be an object`,
		);
	}
	const { keyPair, nonce, url, kid, payload } = options;
	const alg = keyPairOf(keyPair, `${where}: keyPair`);
	if (typeof nonce !== 'string' || !isBase64url(nonce)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: nonce must be the server's Replay-Nonce, a non-empty base64url string, not ${JSON.stringify(nonce)}`,
		);
	}
	checkUrl(url, 'url');
	if (kid !== undefined) checkUrl(kid, 'kid');
	if (
		payload !== undefined &&
		(typeof payload !== 'object' || payload === null || Array.isArray(payload))
	) {
		const kind =
			payload === null
				? 'null'
				: Array.isArray(payload)
					? 'an array'
					: typeof payload;
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: payload must be an object or left out for POST-as-GET, not ${kind}`,
		);
	}
	let json = '';
	if (payload !== undefined) {
		try {
			json = JSON.stringify(payload);
		} catch (error) {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: payload cannot be written as JSON: ${(error as Error).message}`,
				{ cause: error },
			);
		}
	}
	const header: ProtectedHeader =
		kid === undefined
			? {
					alg,
					nonce,
					url,
					jwk: await jwkOf(keyPair.publicKey, `${where}: keyPair.publicKey`),
				}
			: { alg, nonce, url, kid };
	const encodedHeader = base64url(JSON.stringify(header));
	const encodedPayload = payload === undefined ? '' : base64url(json);
	const signature = await crypto.subtle.sign(
		SIGN_PARAMS[alg],
		keyPair.privateKey,
		new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
	);
	return {
		protected: encodedHeader,
		payload: encodedPayload,
		signature: base64url(new Uint8Array(signature)),
	};
}

function checkUrl(value: unknown, name: string): void {
	let parsed: URL | undefined;
	try {
		parsed = typeof value === 'string' ? new URL(value) : undefined;
	} catch {
		parsed = undefined;
	}
	if (parsed?.protocol !== 'https:') {
		throw new AcmeError(
			'INVALID_OPTION',
			`signJws(): ${name} must be an https: URL, not ${JSON.stringify(value)}`,
		);
	}
}
