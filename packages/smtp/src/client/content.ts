import { SmtpError } from '../errors';
import { DataWriter } from '../protocol/data-writer';
import type { MessageSource } from './options';

/** The slice of a message in memory sent at once. */
const SLICE = 64 * 1024;

/** A message ready to send: what is known of it before the first byte, and its bytes. */
export interface Content {
	/** Bytes, when known before sending: SIZE declares it. */
	readonly size?: number;
	/** A byte above 127, when known before sending: it needs 8BITMIME. */
	readonly eightBit: boolean;
	/** The message's bytes, as they come. */
	chunks(): AsyncIterable<Uint8Array>;
}

/** The error for a bare CR or LF in the message: a server must refuse it, and this client does first. */
export const bareLineBreak = () =>
	new SmtpError(
		'BARE_LINE_BREAK',
		'sendMail(): the message holds a bare CR or LF, which a server must refuse (SMTP smuggling); end every line with CRLF, or pass normalizeLineEnds: true',
	);

async function* slices(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	for (let at = 0; at < bytes.length; at += SLICE) {
		yield bytes.subarray(at, at + SLICE);
	}
}

async function* streamed(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (!(value instanceof Uint8Array)) {
				throw new SmtpError(
					'INVALID_OPTION',
					'sendMail(): a message stream must give Uint8Array chunks',
				);
			}
			yield value;
		}
	} finally {
		// A delivery that failed half-way stops the stream it read.
		reader.cancel().catch(() => {});
	}
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
				return streamed(message);
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
	const writer = new DataWriter(normalize);
	for (let at = 0; at < bytes.length; at += SLICE) {
		writer.write(bytes.subarray(at, at + SLICE));
	}
	writer.end();
	if (writer.bareLineBreaks > 0) throw bareLineBreak();
	return {
		size: bytes.length,
		eightBit: writer.eightBit,
		chunks: () => slices(bytes),
	};
}
