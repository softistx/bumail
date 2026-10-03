/** A header field (or several), CRLF included, put on top of a message. */
export function concat(head: string, body: Uint8Array): Uint8Array {
	const top = new TextEncoder().encode(head);
	const out = new Uint8Array(top.length + body.length);
	out.set(top);
	out.set(body, top.length);
	return out;
}
