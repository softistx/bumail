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
 * chunk by chunk, counted, and copied into a `Blob` as it goes, so nothing
 * the caller changes afterwards reaches the store. A stream that fails, or
 * yields something other than bytes, is cancelled and rejects with
 * `INVALID`; so does one already locked by another reader.
 */
export async function readBlob(content: Content): Promise<ReadBlob> {
	const hasher = new Bun.CryptoHasher('sha256');
	if (content instanceof Uint8Array) {
		return {
			blobId: hasher.update(content).digest('hex'),
			size: content.length,
			blob: new Blob([content as Uint8Array<ArrayBuffer>]),
		};
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
	const parts: Blob[] = [];
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
			// A Blob copies the chunk now: the stream may reuse its buffer.
			parts.push(new Blob([value as Uint8Array<ArrayBuffer>]));
			size += value.length;
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (error instanceof StoreError) throw error;
		throw new StoreError(
			'INVALID',
			`The message content could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { blobId: hasher.digest('hex'), size, blob: new Blob(parts) };
}
