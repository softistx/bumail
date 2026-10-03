/**
 * SASL PLAIN (RFC 4616), as AUTHENTICATE PLAIN reads it.
 *
 * A deliberate duplicate of `decodePlain` in `@bumail/smtp`
 * (`src/protocol/sasl.ts`): about forty lines, recorded in AGENTS.md, rather
 * than a peer on the SMTP server for an IMAP server, or a package of its
 * own for one function. A fix to one is a fix to the other.
 */

/** What a client gave to LOGIN or AUTHENTICATE PLAIN. */
export interface Credentials {
	readonly mechanism: 'LOGIN' | 'PLAIN';
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

/** PLAIN: `authzid NUL authcid NUL passwd`, in base64. */
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
