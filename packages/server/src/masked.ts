/**
 * The shortest password masked wherever it occurs. A shorter one, in
 * characters, is masked only where a URL holds it (`:…@`): replacing
 * `x` everywhere would turn "execute" into "e…ecute", and the reason
 * would no longer say what went wrong — while a password that short is
 * guessed anyway.
 */
const MIN_BARE = 4;

/**
 * `text` with a URL's password masked, as written in the URL and decoded,
 * if it decodes: what a store opening a URL repeats of the client's
 * reason, which may name it. Its userinfo form, `:password@`, is always
 * masked; the password alone, elsewhere, only from `MIN_BARE` characters.
 */
export function masked(text: string, raw: string): string {
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// Not percent-encoding a client reads either: the raw form is what it would repeat.
	}
	const forms = [raw, decoded].filter((password) => password !== '');
	let out = text;
	for (const password of forms) {
		out = out.replaceAll(`:${password}@`, ':…@');
	}
	for (const password of forms) {
		if ([...password].length >= MIN_BARE) out = out.replaceAll(password, '…');
	}
	return out;
}
