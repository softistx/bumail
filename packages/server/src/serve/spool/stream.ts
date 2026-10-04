import type { FileHandle } from 'node:fs/promises';

/** How much one read of a spooled file asks for. */
const CHUNK = 64 * 1024;

/**
 * The bytes of the open file `handle` from `start` to `end`, each read at
 * its own position: several streams may read one file at once, and the
 * file needs no name while they do.
 */
export function handleStream(
	handle: FileHandle,
	start: number,
	end: number,
): ReadableStream<Uint8Array> {
	let at = start;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (at >= end) {
				controller.close();
				return;
			}
			const buffer = new Uint8Array(Math.min(CHUNK, end - at));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
			if (bytesRead === 0) {
				controller.close();
				return;
			}
			at += bytesRead;
			controller.enqueue(buffer.subarray(0, bytesRead));
		},
	});
}

/** `prefix`, then `rest`, as one stream. */
export function spooledStream(
	prefix: Uint8Array,
	rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let sentPrefix = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sentPrefix) {
				sentPrefix = true;
				if (prefix.length > 0) {
					controller.enqueue(prefix);
					return;
				}
			}
			reader ??= rest.getReader();
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel(reason) {
			await (reader ?? rest).cancel(reason);
		},
	});
}
