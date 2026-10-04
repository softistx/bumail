import { describe, expect, test } from 'bun:test';
import { AcmeError } from '../errors';
import { jwkThumbprint } from '../jws/jwk';
import { generateKeyPair } from '../keys/keys';
import { http01Path, keyAuthorization } from './http01';

/** RFC 8555 §8.3's example token. */
const TOKEN = 'LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0';

describe('keyAuthorization (RFC 8555 §8.1)', () => {
	test('token, a dot, the thumbprint of the account key', async () => {
		const { publicKey } = await generateKeyPair('P-256');
		expect(await keyAuthorization(TOKEN, publicKey)).toBe(
			`${TOKEN}.${await jwkThumbprint(publicKey)}`,
		);
	});

	test('with the RFC 7638 example key as a JWK', async () => {
		const jwk = {
			kty: 'RSA',
			e: 'AQAB',
			n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
		};
		expect(await keyAuthorization(TOKEN, jwk)).toBe(
			`${TOKEN}.NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs`,
		);
	});
});

describe('http01Path (RFC 8555 §8.3)', () => {
	test('a token of 1024 characters is taken', () => {
		expect(http01Path('a'.repeat(1024))).toEndWith('a'.repeat(1024));
	});

	test('/.well-known/acme-challenge/<token>', () => {
		expect(http01Path(TOKEN)).toBe(`/.well-known/acme-challenge/${TOKEN}`);
	});

	test.each([
		['', '""'],
		['../etc/passwd', '"../etc/passwd"'],
		['a/b', '"a/b"'],
		['a b', '"a b"'],
		[42, 'number'],
		[1n, 'bigint'],
		[null, 'null'],
		['a'.repeat(1025), `"${'a'.repeat(80)}…"`],
	])('%p is INVALID_TOKEN', async (token, shown) => {
		const message = `http01Path(): a challenge token is a non-empty base64url string of at most 1024 characters, not ${shown}`;
		expect(() => http01Path(token as never)).toThrow(
			new AcmeError('INVALID_TOKEN', message),
		);
		const { publicKey } = await generateKeyPair('P-256');
		await expect(keyAuthorization(token as never, publicKey)).rejects.toThrow(
			message.replace('http01Path()', 'keyAuthorization()'),
		);
	});
});
