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
 * next is read. A stream that fails, yields something other than bytes, or
 * whose chunk `onChunk` refuses, is cancelled and rejects with `INVALID`
 * (a `StoreError` from `onChunk` passes through as it is); so does one
 * already locked by another reader. A chunk may be reused by its stream
 * once `onChunk` returns: copy what must be kept.
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
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				throw new StoreError('INVALID', NOT_CONTENT);
			}
			hasher.update(value);
			size += value.length;
			await onChunk(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (error instanceof StoreError) throw error;
		throw new StoreError(
			'INVALID',
			`The message content could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { blobId: hasher.digest('hex'), size };
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
