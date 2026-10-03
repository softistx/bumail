/** A body read whole, or the reason it was not. */
export type ReadBody =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly reason: 'tooLarge' };

/**
 * Reads a request body, never holding more than `max` bytes: a
 * `Content-Length` above it is refused unread, and a body that streams past
 * it — whatever `Content-Length` said, or without one — is cancelled there.
 */
export async function readBounded(
	request: Request,
	max: number,
): Promise<ReadBody> {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > max) {
		await request.body?.cancel().catch(() => undefined);
		return { ok: false, reason: 'tooLarge' };
	}
	if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return { ok: false, reason: 'tooLarge' };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { ok: true, bytes };
}
