/** base64url without padding (RFC 7515 §2, RFC 8555 §6.1). */
export function base64url(bytes: Uint8Array | string): string {
	const data =
		typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
		'base64url',
	);
}

/** Whether a string is non-empty base64url, unpadded, as a token or a nonce is. */
export function isBase64url(text: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(text);
}

/** A PEM block (RFC 7468): the label, then base64 in lines of 64. */
export function pem(label: string, der: Uint8Array): string {
	const body = Buffer.from(der.buffer, der.byteOffset, der.byteLength)
		.toString('base64')
		.replace(/.{64}/g, '$&\n')
		.replace(/\n$/, '');
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** The bytes of the first PEM block with that label, or undefined. */
export function pemBytes(text: string, label: string): Uint8Array | undefined {
	const match = new RegExp(
		`-----BEGIN ${label}-----\\s*([A-Za-z0-9+/=\\s]*?)\\s*-----END ${label}-----`,
	).exec(text);
	const body = match?.[1]?.replace(/\s+/g, '');
	if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
		return undefined;
	}
	return new Uint8Array(Buffer.from(body, 'base64'));
}
