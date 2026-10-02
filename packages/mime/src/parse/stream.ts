import { MimeError } from '../errors';
import { type MessageHeaders, parseHeaderBlock } from '../headers/fields';
import { type ContentType, parseContentType } from '../headers/parameters';

/** A part of a message as the parser meets it. */
export interface PartInfo {
	/**
	 * Where the part sits, as IMAP numbers parts (RFC 9051 §6.4.5): `''` for
	 * the message itself, `'1'` for its first child, `'1.2'` for that child's
	 * second.
	 */
	readonly path: string;
	readonly headers: MessageHeaders;
	readonly contentType: ContentType;
}

/**
 * What the parser reports, in order: a part's headers, then — for a part
 * that is not multipart — its body in as many chunks as it arrives, still
 * in its transfer encoding, then its end. A multipart's children come
 * between its `headers` and its `end`.
 */
export type MimeEvent =
	| { readonly type: 'headers'; readonly part: PartInfo }
	| {
			readonly type: 'body';
			readonly part: PartInfo;
			readonly data: Uint8Array;
	  }
	| { readonly type: 'end'; readonly part: PartInfo };

export interface MimeParserOptions {
	/** The largest header block of one part, in bytes. Default 64 KiB. */
	readonly maxHeaderBytes?: number;
	/**
	 * How deep multiparts nest before a deeper one is read as an opaque
	 * body. Default 32.
	 */
	readonly maxDepth?: number;
	/**
	 * How long a body line may grow, in bytes, before it is passed on without
	 * waiting for its end. Default 64 KiB.
	 */
	readonly maxLineBytes?: number;
}

type State = 'headers' | 'preamble' | 'parts' | 'body' | 'epilogue';

interface Frame {
	readonly path: string;
	readonly depth: number;
	state: State;
	part?: PartInfo;
	boundary?: Uint8Array;
	children: number;
	header: Uint8Array[];
	headerSize: number;
	/** The line break after the last body line, held until the next line shows it is not a delimiter's. */
	held?: Uint8Array | undefined;
}

const LF = 0x0a;
const CR = 0x0d;
const DASH = 0x2d;
/** RFC 2046 §5.1.1 caps a boundary at 70 characters; padding may follow a delimiter. */
const DELIMITER_MAX = 1000;

function lineBreakLength(line: Uint8Array): number {
	if (line[line.length - 1] !== LF) return 0;
	return line[line.length - 2] === CR ? 2 : 1;
}

function startsWith(line: Uint8Array, prefix: Uint8Array): boolean {
	if (line.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (line[i] !== prefix[i]) return false;
	}
	return true;
}

/** `'close'` for `--boundary--`, `'next'` for `--boundary`, `undefined` otherwise. */
function delimiter(
	content: Uint8Array,
	boundary: Uint8Array,
): 'next' | 'close' | undefined {
	if (!startsWith(content, boundary)) return undefined;
	let i = boundary.length;
	let close = false;
	if (content[i] === DASH && content[i + 1] === DASH) {
		close = true;
		i += 2;
	}
	for (; i < content.length; i++) {
		if (content[i] !== 0x20 && content[i] !== 0x09) return undefined;
	}
	return close ? 'close' : 'next';
}

/**
 * A push parser for MIME messages (RFC 2045, RFC 2046): give it the message
 * in chunks of any size, and it gives back events as soon as each is known.
 * It keeps one line and one header block in memory, never a body, so a
 * message of any size is read in bounded memory.
 *
 * It follows RFC 2046 §5.1.1: the line break before a delimiter belongs to
 * the delimiter, a delimiter may be followed by white space, the preamble
 * and the epilogue are ignored, and an enclosing multipart's delimiter ends
 * every part inside it. Bare LF line endings are read like CRLF.
 */
export class MimeParser {
	readonly #maxHeaderBytes: number;
	readonly #maxDepth: number;
	readonly #maxLineBytes: number;
	readonly #stack: Frame[] = [];
	#buffer: Uint8Array = new Uint8Array(0);
	/** The current line was already passed on in part: it cannot be a delimiter. */
	#midLine = false;
	#events: MimeEvent[] = [];
	#ended = false;

	constructor(options: MimeParserOptions = {}) {
		this.#maxHeaderBytes = options.maxHeaderBytes ?? 64 * 1024;
		this.#maxDepth = options.maxDepth ?? 32;
		this.#maxLineBytes = options.maxLineBytes ?? 64 * 1024;
		this.#stack.push(this.#frame('', 0));
	}

	#frame(path: string, depth: number): Frame {
		return {
			path,
			depth,
			state: 'headers',
			children: 0,
			header: [],
			headerSize: 0,
		};
	}

	/** Parses a chunk; returns the events it completed. */
	write(chunk: Uint8Array): MimeEvent[] {
		if (this.#ended)
			throw new Error('MimeParser.write(): the parser has ended');
		let data = chunk;
		if (this.#buffer.length > 0) {
			data = new Uint8Array(this.#buffer.length + chunk.length);
			data.set(this.#buffer, 0);
			data.set(chunk, this.#buffer.length);
		}
		let start = 0;
		for (;;) {
			const lf = data.indexOf(LF, start);
			if (lf < 0) break;
			this.#line(data.subarray(start, lf + 1));
			this.#midLine = false;
			start = lf + 1;
		}
		let rest = data.subarray(start);
		if (rest.length > this.#maxLineBytes && this.#top().state !== 'headers') {
			// Keep the last byte: it may be the CR of a CRLF split across chunks.
			this.#line(rest.subarray(0, rest.length - 1));
			this.#midLine = true;
			rest = rest.subarray(rest.length - 1);
		}
		this.#buffer = rest.slice();
		this.#checkHeaderSize(this.#buffer.length);
		return this.#take();
	}

	/** Ends the message; returns the last events, the end of every open part included. */
	end(): MimeEvent[] {
		if (this.#ended) return [];
		if (this.#buffer.length > 0) this.#line(this.#buffer);
		this.#buffer = new Uint8Array(0);
		this.#ended = true;
		while (this.#stack.length > 0) this.#close(true);
		return this.#take();
	}

	#take(): MimeEvent[] {
		const events = this.#events;
		this.#events = [];
		return events;
	}

	#top(): Frame {
		return this.#stack[this.#stack.length - 1] as Frame;
	}

	#checkHeaderSize(extra: number): void {
		const top = this.#top();
		if (
			top.state === 'headers' &&
			top.headerSize + extra > this.#maxHeaderBytes
		) {
			throw new MimeError(
				'HEADER_TOO_LARGE',
				`The header block of part "${top.path}" is larger than ${this.#maxHeaderBytes} bytes`,
			);
		}
	}

	#line(line: Uint8Array): void {
		const breakLength = lineBreakLength(line);
		const content = line.subarray(0, line.length - breakLength);
		if (
			!this.#midLine &&
			content[0] === DASH &&
			content[1] === DASH &&
			content.length <= DELIMITER_MAX &&
			this.#delimiterLine(content.subarray(2))
		)
			return;

		const top = this.#top();
		switch (top.state) {
			case 'headers':
				if (content.length === 0 && !this.#midLine) this.#headersDone(top);
				else {
					this.#checkHeaderSize(line.length);
					top.header.push(line.slice());
					top.headerSize += line.length;
				}
				return;
			case 'body': {
				const part = top.part as PartInfo;
				if (top.held) this.#emitBody(part, top.held);
				if (content.length > 0) this.#emitBody(part, content.slice());
				top.held = breakLength > 0 ? line.slice(content.length) : undefined;
				return;
			}
			default:
				// Preamble and epilogue: RFC 2046 §5.1.1 says to ignore them.
				return;
		}
	}

	#emitBody(part: PartInfo, data: Uint8Array): void {
		this.#events.push({ type: 'body', part, data });
	}

	/** Handles a delimiter line of any enclosing multipart; `false` when it is none. */
	#delimiterLine(afterDashes: Uint8Array): boolean {
		for (let i = this.#stack.length - 1; i >= 0; i--) {
			const frame = this.#stack[i] as Frame;
			if (!frame.boundary || frame.state === 'epilogue') continue;
			const kind = delimiter(afterDashes, frame.boundary);
			if (!kind) continue;
			while (this.#stack.length - 1 > i) this.#close(false);
			if (kind === 'close') {
				frame.state = 'epilogue';
			} else {
				frame.state = 'parts';
				frame.children++;
				const path =
					frame.path === ''
						? `${frame.children}`
						: `${frame.path}.${frame.children}`;
				this.#stack.push(this.#frame(path, frame.depth + 1));
			}
			return true;
		}
		return false;
	}

	#headersDone(frame: Frame): void {
		const size = frame.header.reduce((sum, line) => sum + line.length, 0);
		const block = new Uint8Array(size);
		let offset = 0;
		for (const line of frame.header) {
			block.set(line, offset);
			offset += line.length;
		}
		const headers = parseHeaderBlock(block);
		frame.header = [];
		const part: PartInfo = {
			path: frame.path,
			headers,
			contentType: parseContentType(headers.get('content-type')),
		};
		frame.part = part;
		this.#events.push({ type: 'headers', part });
		const boundary = part.contentType.parameters['boundary'];
		if (
			part.contentType.type === 'multipart' &&
			boundary &&
			frame.depth < this.#maxDepth
		) {
			frame.boundary = new TextEncoder().encode(boundary);
			frame.state = 'preamble';
		} else {
			frame.state = 'body';
		}
	}

	/** Closes the innermost part; at the end of input, its held line break is body. */
	#close(atEnd: boolean): void {
		const frame = this.#stack.pop() as Frame;
		if (frame.state === 'headers') this.#headersDone(frame);
		const part = frame.part as PartInfo;
		if (atEnd && frame.held) this.#emitBody(part, frame.held);
		frame.held = undefined;
		this.#events.push({ type: 'end', part });
	}
}

/**
 * Parses a message from a stream, yielding events as they complete. The
 * stream is read once, in bounded memory.
 */
export async function* parseMimeStream(
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	options?: MimeParserOptions,
): AsyncGenerator<MimeEvent> {
	const parser = new MimeParser(options);
	for await (const chunk of source as AsyncIterable<Uint8Array>) {
		yield* parser.write(chunk);
	}
	yield* parser.end();
}
