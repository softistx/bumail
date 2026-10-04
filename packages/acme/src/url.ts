/** The longest URL taken, from the caller or the CA. */
const MAX_URL_LENGTH = 2048;

/**
 * Whether `value` is a URL a signed ACME request goes to: `https:` (or
 * `http:` with `allowInsecure`), at most 2048 characters, without white
 * space, a control character, credentials or a fragment. `signJws` and
 * the client both check URLs with it.
 */
export function isRequestUrl(value: unknown, allowInsecure: boolean): boolean {
	if (
		typeof value !== 'string' ||
		value.length > MAX_URL_LENGTH ||
		/[\s\p{Cc}#]/u.test(value)
	) {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return (
		(parsed.protocol === 'https:' ||
			(allowInsecure && parsed.protocol === 'http:')) &&
		parsed.username === '' &&
		parsed.password === ''
	);
}
