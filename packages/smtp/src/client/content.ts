import { SmtpError } from '../errors';
import { DataWriter } from '../protocol/data-writer';
import type { MessageSource } from './options';

/** The slice of a message in memory sent at once. */
const SLICE = 64 * 1024;

/** The message's bytes, one slice at a time; `undefined` once they end. */
export interface Chunks {
	next(): Promise<Uint8Array | undefined>;
	/** Stops reading: a delivery that failed half-way. */
	cancel(): void;
}

/** A message ready to send: what is known of it before the first byte, and its bytes. */
export interface Content {
	/** Bytes, when known before sending: SIZE declares it. */
	readonly size?: number;
	/** A byte above 127, when known before sending: it needs 8BITMIME. */
	readonly eightBit: boolean;
	chunks(): Chunks;
}

/** The error for a bare CR or LF in the message: a server must refuse it, and this client does first. */
export const bareLineBreak = () =>
	new SmtpError(
		'BARE_LINE_BREAK',
		'sendMail(): the message holds a bare CR or LF, which a server must refuse (SMTP smuggling); end every line with CRLF, or pass normalizeLineEnds: true',
	);

/** Bytes in `SLICE`s, so no chunk sent at once is larger. */
function sliced(next: () => Promise<Uint8Array | undefined>) {
	let held: Uint8Array | undefined;
	return async (): Promise<Uint8Array | undefined> => {
		if (!held || held.length === 0) held = await next();
		if (!held) return undefined;
		const slice = held.subarray(0, SLICE);
		held = held.subarray(SLICE);
		return slice;
	};
}

function fromBytes(bytes: Uint8Array): Chunks {
	let given = false;
	const next = sliced(async () => {
		if (given) return undefined;
		given = true;
		return bytes;
	});
	return { next, cancel() {} };
}

function fromStream(stream: ReadableStream<Uint8Array>): Chunks {
	const reader = stream.getReader();
	const next = sliced(async () => {
		const { done, value } = await reader.read();
		if (done) return undefined;
		if (!(value instanceof Uint8Array)) {
			throw new SmtpError(
				'INVALID_OPTION',
				'sendMail(): a message stream must give Uint8Array chunks',
			);
		}
		return value;
	});
	return {
		next,
		cancel: () => void reader.cancel().catch(() => {}),
	};
}

/**
 * The message, checked before any connection when it is in memory: a bare
 * CR or LF is refused here (unless normalised), and its size and 8-bit
 * bytes are known for MAIL FROM. A stream is checked as it is sent.
 */
export function contentOf(
	message: MessageSource,
	normalize: boolean,
	size: number | undefined,
): Content {
	if (message instanceof ReadableStream) {
		let read = false;
		return {
			...(size === undefined ? {} : { size }),
			eightBit: false,
			chunks() {
				if (read) {
					throw new SmtpError(
						'INVALID_OPTION',
						'sendMail(): a message stream can be sent once only',
					);
				}
				read = true;
				return fromStream(message);
			},
		};
	}
	let bytes: Uint8Array;
	if (typeof message === 'string') bytes = new TextEncoder().encode(message);
	else if (message instanceof Uint8Array) bytes = message;
	else {
		throw new SmtpError(
			'INVALID_OPTION',
			'sendMail(): the message must be a Uint8Array, a string or a ReadableStream',
		);
	}
	// One dry run: what the server will be sent, its size as normalised.
	const writer = new DataWriter(normalize);
	let sent = 0;
	for (let at = 0; at < bytes.length; at += SLICE) {
		sent += writer.write(bytes.subarray(at, at + SLICE)).length;
	}
	writer.end();
	if (writer.bareLineBreaks > 0) throw bareLineBreak();
	return {
		size: sent,
		eightBit: writer.eightBit,
		chunks: () => fromBytes(bytes),
	};
}
