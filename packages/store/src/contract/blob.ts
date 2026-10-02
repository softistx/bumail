/** The id of a blob: the SHA-256 of its bytes, in hex. Two stores give the same bytes the same id. */
export function blobIdOf(content: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}
