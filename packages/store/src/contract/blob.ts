import { StoreError } from '../errors';
import type { Content } from './types';

/** The id of a blob: the SHA-256 of its bytes, in hex. Two stores give the same bytes the same id. */
export function blobIdOf(content: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

/** Content read to its end: its id, its size, and the bytes as an immutable `Blob`. */
export interface ReadBlob {
	readonly blobId: string;
	readonly size: number;
	readonly blob: Blob;
}

const NOT_CONTENT =
	'A message content is a Uint8Array or a ReadableStream<Uint8Array>';

/**
 * Reads content given whole or as a stream, as every store must: hashed
 * and counted chunk by chunk, each chunk handed to `onChunk` before the
 * next is read. A stream that fails or yields something other than bytes
 * is cancelled and rejects with `INVALID`; so does one already locked by
 * another reader. What `onChunk` throws (the store's own write failing)
 * is the store's, not the content's: the stream is cancelled and the error
 * passes through as it is. A chunk may be reused by its stream once
 * `onChunk` returns: copy what must be kept.
 */
export async function readChunks(
	content: Content,
	onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<{ blobId: string; size: number }> {
	const hasher = new Bun.CryptoHasher('sha256');
	if (content instanceof Uint8Array) {
		hasher.update(content);
		await onChunk(content);
		return { blobId: hasher.digest('hex'), size: content.length };
	}
	if (!(content instanceof ReadableStream)) {
		throw new StoreError('INVALID', NOT_CONTENT);
	}
	if (content.locked) {
		throw new StoreError(
			'INVALID',
			'The message content stream is locked: another reader holds it',
		);
	}
	let size = 0;
	const reader = content.getReader();
	for (;;) {
		const value = await nextChunk(reader);
		if (value === undefined) break;
		hasher.update(value);
		size += value.length;
		try {
			await onChunk(value);
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
		}
	}
	return { blobId: hasher.digest('hex'), size };
}

/** The next chunk of the stream, or `undefined` at its end; a read that fails is `INVALID`. */
async function nextChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | undefined> {
	let result: ReadableStreamDefaultReadResult<Uint8Array>;
	try {
		result = await reader.read();
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw new StoreError(
			'INVALID',
			`The message content could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (result.done) return undefined;
	if (!((result.value as unknown) instanceof Uint8Array)) {
		await reader.cancel().catch(() => undefined);
		throw new StoreError('INVALID', NOT_CONTENT);
	}
	return result.value;
}

/**
 * Reads content into an immutable `Blob`, as `readChunks` reads it: each
 * chunk is copied as it comes, so nothing the caller changes afterwards
 * reaches the store, and a stream that fails rejects with `INVALID`.
 */
export async function readBlob(content: Content): Promise<ReadBlob> {
	const parts: Blob[] = [];
	const { blobId, size } = await readChunks(content, (chunk) => {
		// A Blob copies the chunk now: the stream may reuse its buffer.
		parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
	});
	return { blobId, size, blob: new Blob(parts) };
}
