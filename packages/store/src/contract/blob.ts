import { StoreError } from '../errors';
import type { Content } from './types';

/** The id of a blob: the SHA-256 of its bytes, in hex. Two stores give the same bytes the same id. */
export function blobIdOf(content: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

/** Content read to its end: hashed chunk by chunk, counted, copied. */
export interface ReadBlob {
	readonly blobId: string;
	readonly size: number;
	readonly chunks: readonly Uint8Array[];
}

/** Reads content given whole or as a stream; the caller's bytes are copied, never kept. */
export async function readBlob(content: Content): Promise<ReadBlob> {
	const hasher = new Bun.CryptoHasher('sha256');
	if (content instanceof Uint8Array) {
		const copy = content.slice();
		return {
			blobId: hasher.update(copy).digest('hex'),
			size: copy.length,
			chunks: [copy],
		};
	}
	if (!(content instanceof ReadableStream)) {
		throw new StoreError(
			'INVALID',
			'A message content is a Uint8Array or a ReadableStream<Uint8Array>',
		);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of content) {
		if (!(chunk instanceof Uint8Array)) {
			throw new StoreError(
				'INVALID',
				'A message content is a Uint8Array or a ReadableStream<Uint8Array>',
			);
		}
		hasher.update(chunk);
		chunks.push(chunk.slice());
		size += chunk.length;
	}
	return { blobId: hasher.digest('hex'), size, chunks };
}
