/** Credentials a client gave with `AUTH`. */
export interface Credentials {
	readonly mechanism: 'PLAIN' | 'LOGIN';
	readonly username: string;
	readonly password: string;
	/**
	 * PLAIN's authorization identity, when it differs from the username.
	 * The server refuses such credentials before `authenticate` is asked.
	 */
	readonly authorizationId?: string;
}

function base64ToText(text: string): string | undefined {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
		return undefined;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(
			Uint8Array.fromBase64(text),
		);
	} catch {
		return undefined;
	}
}

/** PLAIN (RFC 4616): `authzid NUL authcid NUL passwd`, in base64. */
export function decodePlain(response: string): Credentials | undefined {
	const text = base64ToText(response);
	if (text === undefined) return undefined;
	const parts = text.split('\0');
	if (parts.length !== 3) return undefined;
	const [authorizationId = '', username = '', password = ''] = parts;
	if (username === '' || password === '') return undefined;
	return {
		mechanism: 'PLAIN',
		username,
		password,
		...(authorizationId === '' || authorizationId === username
			? {}
			: { authorizationId }),
	};
}

/** One step of LOGIN: a base64 line to its text. */
export function decodeLoginStep(response: string): string | undefined {
	return base64ToText(response);
}

const base64 = (text: string) => new TextEncoder().encode(text).toBase64();

/** A client's PLAIN response (RFC 4616): `NUL username NUL password`, in base64, no authorization identity. */
export function encodePlain(username: string, password: string): string {
	return base64(`\0${username}\0${password}`);
}

/** One step of LOGIN, the username or the password, in base64. */
export function encodeLoginStep(text: string): string {
	return base64(text);
}
