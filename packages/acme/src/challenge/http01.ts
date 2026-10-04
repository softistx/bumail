import { isBase64url } from '../encoding';
import { AcmeError } from '../errors';
import { jwkThumbprint } from '../jws/jwk';

function checkToken(token: unknown, where: string): string {
	if (typeof token !== 'string' || !isBase64url(token)) {
		throw new AcmeError(
			'INVALID_TOKEN',
			`${where}: a challenge token is a non-empty base64url string, not ${JSON.stringify(token)}`,
		);
	}
	return token;
}

/**
 * The key authorization of a challenge (RFC 8555 §8.1): the token, a dot,
 * and the account key's JWK thumbprint (RFC 7638). An HTTP-01 challenge
 * serves it as is; DNS-01 publishes its SHA-256 instead.
 */
export async function keyAuthorization(
	token: string,
	accountKey: CryptoKey | JsonWebKey,
): Promise<string> {
	checkToken(token, 'keyAuthorization()');
	return `${token}.${await jwkThumbprint(accountKey)}`;
}

/**
 * The path an HTTP-01 challenge is fetched at on port 80 (RFC 8555 §8.3):
 * `/.well-known/acme-challenge/<token>`. Answer a GET there with the key
 * authorization, as `application/octet-stream` or plain text.
 */
export function http01Path(token: string): string {
	return `/.well-known/acme-challenge/${checkToken(token, 'http01Path()')}`;
}
