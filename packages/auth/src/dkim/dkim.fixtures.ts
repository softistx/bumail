/**
 * The RFCs' own examples, as printed, for the specs: lines joined with
 * CRLF, the RFC's three-space page indent removed.
 */

/** RFC 8463 Appendix A.1: the Ed25519 secret key (RFC 8032 §7.1, test 1), base64. */
export const RFC8463_ED25519_PRIVATE =
	'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=';

/** RFC 8463 Appendix A.1: the RSA secret key, PKCS #1 PEM. */
export const RFC8463_RSA_PRIVATE = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDkHlOQoBTzWRiGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQi
Y/J16JYi0Qvx/byYzCNb3W91y3FutACDfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqM
KrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3Ip3G+2kryOTIKT+l/K4w3QIDAQAB
AoGAH0cxOhFZDgzXWhDhnAJDw5s4roOXN4OhjiXa8W7Y3rhX3FJqmJSPuC8N9vQm
6SVbaLAE4SG5mLMueHlh4KXffEpuLEiNp9Ss3O4YfLiQpbRqE7Tm5SxKjvvQoZZe
zHorimOaChRL2it47iuWxzxSiRMv4c+j70GiWdxXnxe4UoECQQDzJB/0U58W7RZy
6enGVj2kWF732CoWFZWzi1FicudrBFoy63QwcowpoCazKtvZGMNlPWnC7x/6o8Gc
uSe0ga2xAkEA8C7PipPm1/1fTRQvj1o/dDmZp243044ZNyxjg+/OPN0oWCbXIGxy
WvmZbXriOWoSALJTjExEgraHEgnXssuk7QJBALl5ICsYMu6hMxO73gnfNayNgPxd
WFV6Z7ULnKyV7HSVYF0hgYOHjeYe9gaMtiJYoo0zGN+L3AAtNP9huqkWlzECQE1a
licIeVlo1e+qJ6Mgqr0Q7Aa7falZ448ccbSFYEPD6oFxiOl9Y9se9iYHZKKfIcst
o7DUw1/hz2Ck4N5JrgUCQQCyKveNvjzkkd8HjYs0SwM0fPjK16//5qDZ2UiDGnOe
uEzxBDAr518Z8VFbR41in3W4Y3yCDgQlLlcETrS+zYcL
-----END RSA PRIVATE KEY-----`;

/** RFC 8463 Appendix A.2: the key records, as the DNS joins their character-strings. */
export const RFC8463_RECORDS = {
	'brisbane._domainkey.football.example.com': {
		txt: ['v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='],
	},
	'test._domainkey.football.example.com': {
		txt: [
			[
				'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR',
				'iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC',
				'DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3',
				'Ip3G+2kryOTIKT+l/K4w3QIDAQAB',
			],
		],
	},
} as const;

/** The message both RFCs sign: RFC 6376 Appendix A.1, RFC 8463 Appendix A.3. */
export const EXAMPLE_HEADERS = [
	'From: Joe SixPack <joe@football.example.com>',
	'To: Suzie Q <suzie@shopping.example.net>',
	'Subject: Is dinner ready?',
	'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
	'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
];

export const EXAMPLE_BODY =
	'Hi.\r\n\r\nWe lost the game.  Are you hungry yet?\r\n\r\nJoe.\r\n';

/** RFC 8463 Appendix A.3: the signed message, both signatures. */
export const RFC8463_MESSAGE = [
	'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;',
	' d=football.example.com; i=@football.example.com;',
	' q=dns/txt; s=brisbane; t=1528637909; h=from : to :',
	' subject : date : message-id : from : subject : date;',
	' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
	' b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus',
	' Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==',
	'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
	' d=football.example.com; i=@football.example.com;',
	' q=dns/txt; s=test; t=1528637909; h=from : to : subject :',
	' date : message-id : from : subject : date;',
	' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
	' b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3',
	' DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz',
	' dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=',
	...EXAMPLE_HEADERS,
	'',
	EXAMPLE_BODY,
].join('\r\n');

/** RFC 8463's signing time, t=1528637909, in milliseconds. */
export const RFC8463_NOW = 1_528_637_909_000;

/** An unsigned message, for the round trips and the hostile specs. */
export function unsigned(body = EXAMPLE_BODY): string {
	return `${EXAMPLE_HEADERS.join('\r\n')}\r\n\r\n${body}`;
}

/** A fresh key pair for an algorithm, and the TXT record that publishes it. */
export async function keyPair(
	algorithm: 'rsa-sha256' | 'ed25519-sha256',
	bits = 1024,
): Promise<{ privateKey: CryptoKey; record: string; publicKey: Uint8Array }> {
	const pair = (
		algorithm === 'rsa-sha256'
			? await crypto.subtle.generateKey(
					{
						name: 'RSASSA-PKCS1-v1_5',
						modulusLength: bits,
						publicExponent: new Uint8Array([1, 0, 1]),
						hash: 'SHA-256',
					},
					true,
					['sign', 'verify'],
				)
			: await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
					'sign',
					'verify',
				])
	) as CryptoKeyPair;
	const format = algorithm === 'rsa-sha256' ? 'spki' : 'raw';
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey(format, pair.publicKey),
	);
	const k = algorithm === 'rsa-sha256' ? 'rsa' : 'ed25519';
	return {
		privateKey: pair.privateKey,
		publicKey,
		record: `v=DKIM1; k=${k}; p=${Buffer.from(publicKey).toString('base64')}`,
	};
}

/** A stream that hands the bytes over in pieces of `size`, to cross every boundary. */
export function streamOf(
	text: string,
	size: number,
): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(at, at + size));
			at += size;
		},
	});
}
