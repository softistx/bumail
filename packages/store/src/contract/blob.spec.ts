import { describe, expect, test } from 'bun:test';
import { StoreError } from '../errors';
import { readChunks } from './blob';

const bytes = (text: string) => new TextEncoder().encode(text);
const full = new Error('disk full');

describe('readChunks: what onChunk throws is the store’s, not the content’s', () => {
	test('content given whole: the error passes through', async () => {
		await expect(
			readChunks(bytes('x'), () => {
				throw full;
			}),
		).rejects.toBe(full);
	});

	test('content as a stream: the error passes through, the stream is cancelled', async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(bytes('x'));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			readChunks(stream, () => {
				throw full;
			}),
		).rejects.toBe(full);
		expect(cancelled).toBe(true);
	});

	test('a stream that fails is still INVALID', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error('reset'));
			},
		});
		const error = await readChunks(stream, () => undefined).catch((e) => e);
		expect(error).toBeInstanceOf(StoreError);
		expect(error).toMatchObject({ code: 'INVALID' });
	});
});
