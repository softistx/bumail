/**
 * `text` with a URL's password masked, as written in the URL and decoded,
 * if it decodes: what a store opening a URL repeats of the client's
 * reason, which may name it.
 */
export function masked(text: string, raw: string): string {
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// Not percent-encoding a client reads either: the raw form is what it would repeat.
	}
	let out = text;
	for (const password of [raw, decoded]) {
		if (password !== '') out = out.replaceAll(password, '…');
	}
	return out;
}
