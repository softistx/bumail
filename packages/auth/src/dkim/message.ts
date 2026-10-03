import { binary } from '../text';

const LF = 0x0a;
const CR = 0x0d;

/** A message as bytes, as a string (written as UTF-8), or as a stream of bytes. */
export type MessageInput = Uint8Array | string | ReadableStream<Uint8Array>;

/** A message cut at the blank line: the header as a binary string (one char per byte), the body still streaming. */
export interface SplitMessage {
	readonly header: string;
	readonly body: AsyncIterable<Uint8Array>;
	/** Stops reading a stream whose body is not wanted. */
	cancel(): Promise<void>;
}

/** Where the header ends and the body starts, if the blank line is in `bytes` past `from`. */
export function headerEnd(
	bytes: Uint8Array,
	from: number,
): { readonly header: number; readonly body: number } | undefined {
	if (from === 0) {
		if (bytes[0] === LF) return { header: 0, body: 1 };
		if (bytes[0] === CR && bytes[1] === LF) return { header: 0, body: 2 };
	}
	for (let i = bytes.indexOf(LF, from); i >= 0; i = bytes.indexOf(LF, i + 1)) {
		if (bytes[i + 1] === LF) return { header: i + 1, body: i + 2 };
		if (bytes[i + 1] === CR && bytes[i + 2] === LF)
			return { header: i + 1, body: i + 3 };
	}
	return undefined;
}

function fromBytes(bytes: Uint8Array, maxHeaderBytes: number): SplitMessage {
	const end = headerEnd(bytes, 0);
	if (end === undefined && bytes.length > maxHeaderBytes) throw tooLarge();
	if (end !== undefined && end.header > maxHeaderBytes) throw tooLarge();
	const body = end === undefined ? new Uint8Array() : bytes.subarray(end.body);
	return {
		header: binary(bytes.subarray(0, end?.header ?? bytes.length)),
		body: (async function* () {
			if (body.length > 0) yield body;
		})(),
		cancel: async () => {},
	};
}

/** Thrown inside the package when the header passes `maxHeaderBytes`. */
export class HeaderTooLarge extends Error {}

function tooLarge(): HeaderTooLarge {
	return new HeaderTooLarge('header too large');
}

async function* rest(
	first: Uint8Array,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
	try {
		if (first.length > 0) yield first;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value.length > 0) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

async function fromStream(
	stream: ReadableStream<Uint8Array>,
	maxHeaderBytes: number,
): Promise<SplitMessage> {
	const reader = stream.getReader();
	let buffer = new Uint8Array(4096);
	let used = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return fromBytes(buffer.subarray(0, used), maxHeaderBytes);
		const searched = Math.max(0, used - 2);
		if (used + value.length > buffer.length) {
			const grown = new Uint8Array(
				Math.max(buffer.length * 2, used + value.length),
			);
			grown.set(buffer.subarray(0, used));
			buffer = grown;
		}
		buffer.set(value, used);
		used += value.length;
		const held = buffer.subarray(0, used);
		const end = headerEnd(held, searched);
		if (end !== undefined || held.length > maxHeaderBytes) {
			if (end === undefined || end.header > maxHeaderBytes) {
				await reader.cancel().catch(() => {});
				throw tooLarge();
			}
			return {
				header: binary(held.subarray(0, end.header)),
				body: rest(held.slice(end.body), reader),
				cancel: () => reader.cancel().catch(() => {}),
			};
		}
	}
}

/**
 * Cuts a message at the blank line that ends its header, reading no more
 * of a stream than the header needs. A header longer than
 * `maxHeaderBytes` throws `HeaderTooLarge`; a message with no blank line
 * is all header and an empty body.
 */
export async function splitMessage(
	input: MessageInput,
	maxHeaderBytes: number,
): Promise<SplitMessage> {
	if (typeof input === 'string') {
		return fromBytes(new TextEncoder().encode(input), maxHeaderBytes);
	}
	if (input instanceof Uint8Array) return fromBytes(input, maxHeaderBytes);
	return fromStream(input, maxHeaderBytes);
}
