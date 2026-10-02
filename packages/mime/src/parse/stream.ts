import { join } from '../encoding/bytes';
import { MimeError } from '../errors';
import { parseHeaderBlock } from '../headers/fields';
import { parseContentType } from '../headers/parameters';
import {
	DASH,
	DELIMITER_MAX,
	delimiter,
	LF,
	limit,
	lineBreakLength,
} from './lines';
import type { MimeEvent, MimeParserOptions, PartInfo } from './types';

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
	/** The line in progress: the chunks since the last LF, joined only once it ends. */
	#pending: Uint8Array[] = [];
	#pendingSize = 0;
	/** The current line was already passed on in part: it cannot be a delimiter. */
	#midLine = false;
	/** Body bytes of one part, gathered into one event per `write`. */
	#body: { part: PartInfo; pieces: Uint8Array[] } | undefined;
	#events: MimeEvent[] = [];
	#ended = false;

	constructor(options: MimeParserOptions = {}) {
		this.#maxHeaderBytes = limit(options, 'maxHeaderBytes', 64 * 1024, 1);
		this.#maxDepth = limit(options, 'maxDepth', 32, 0);
		this.#maxLineBytes = limit(
			options,
			'maxLineBytes',
			64 * 1024,
			DELIMITER_MAX,
		);
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
		let start = 0;
		for (;;) {
			const lf = chunk.indexOf(LF, start);
			if (lf < 0) break;
			let line = chunk.subarray(start, lf + 1);
			if (this.#pendingSize > 0) {
				line = join([...this.#pending, line]);
				this.#pending = [];
				this.#pendingSize = 0;
			}
			this.#line(line);
			this.#midLine = false;
			start = lf + 1;
		}
		if (start < chunk.length) {
			// Copied: the caller may reuse its buffer once write returns.
			this.#pending.push(chunk.slice(start));
			this.#pendingSize += chunk.length - start;
		}
		if (
			this.#pendingSize > this.#maxLineBytes &&
			this.#top().state !== 'headers'
		) {
			const line = join(this.#pending);
			// Keep the last byte: it may be the CR of a CRLF split across chunks.
			this.#line(line.subarray(0, line.length - 1));
			this.#midLine = true;
			this.#pending = [line.subarray(line.length - 1)];
			this.#pendingSize = 1;
		}
		this.#checkHeaderSize(this.#pendingSize);
		this.#flushBody();
		return this.#take();
	}

	/** Ends the message; returns the last events, the end of every open part included. */
	end(): MimeEvent[] {
		if (this.#ended) return [];
		if (this.#pendingSize > 0) this.#line(join(this.#pending));
		this.#pending = [];
		this.#pendingSize = 0;
		this.#ended = true;
		while (this.#stack.length > 0) this.#close(true);
		this.#flushBody();
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
				if (content.length > 0) this.#emitBody(part, content);
				top.held = breakLength > 0 ? line.slice(content.length) : undefined;
				return;
			}
			default:
				// Preamble and epilogue: RFC 2046 §5.1.1 says to ignore them.
				return;
		}
	}

	#emitBody(part: PartInfo, data: Uint8Array): void {
		if (this.#body && this.#body.part !== part) this.#flushBody();
		this.#body ??= { part, pieces: [] };
		this.#body.pieces.push(data);
	}

	/** The gathered body bytes as one event, copied out of the caller's chunks. */
	#flushBody(): void {
		if (!this.#body) return;
		const { part, pieces } = this.#body;
		this.#body = undefined;
		this.#events.push({ type: 'body', part, data: join(pieces) });
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
		this.#flushBody();
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
		this.#flushBody();
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
