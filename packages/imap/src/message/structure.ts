import { parseContentType, parseHeaderBlock } from '@bumail/mime';
import { delimiter, type Entity, isMessage, newEntity } from './entity';
import { join, type Line, LineSplitter } from './lines';

export type { Entity } from './entity';

/** How deep multiparts and messages nest before a deeper one is read as an opaque body. */
const MAX_DEPTH = 32;
/** Parts a message may have; past them, a delimiter is read as body text. */
const MAX_PARTS = 1000;
/** The header of one entity kept, in bytes. */
const MAX_HEADER = 64 * 1024;
/** The headers of all entities kept, in bytes. */
const MAX_HEADERS = 1024 * 1024;
/** What is kept of a body line: enough to tell a delimiter (RFC 2046 §5.1.1). */
const BODY_LINE = 1000;

const DIGEST_DEFAULT = parseContentType('message/rfc822');

type State = 'headers' | 'body' | 'message' | 'preamble' | 'epilogue';

interface Frame {
	readonly entity: Entity;
	readonly depth: number;
	readonly inDigest: boolean;
	state: State;
	header: Uint8Array[];
	headerSize: number;
	boundary?: Uint8Array;
	/** Lines finished before the body started. */
	lineStart: number;
}

/**
 * Reads a message once, as it streams, into its tree of entities with
 * their offsets: what BODYSTRUCTURE describes and BODY[section] slices. It
 * keeps a bounded part of each line, a bounded header per entity and in
 * all, and a bounded number of parts nested a bounded depth, so a message
 * of any size or shape costs a bounded amount of memory.
 */
export class StructureScanner {
	readonly root: Entity;
	readonly #frames: Frame[];
	readonly #lines: LineSplitter;
	#lineIndex = 0;
	#previousEmpty = false;
	/** The line break of the last line read. */
	#lastBreak = 0;
	#parts = 0;
	#headerBudget = MAX_HEADERS;
	readonly #headerOnly: boolean;
	/** With `headerOnly`, set once the message's own header was read. */
	done = false;

	constructor(headerOnly = false) {
		this.#headerOnly = headerOnly;
		this.root = newEntity(0);
		this.#frames = [this.#frame(this.root, 0, false)];
		this.#lines = new LineSplitter(
			() => (this.#top().state === 'headers' ? MAX_HEADER : BODY_LINE),
			(line) => this.#line(line),
		);
	}

	#frame(entity: Entity, depth: number, inDigest: boolean): Frame {
		return {
			entity,
			depth,
			inDigest,
			state: 'headers',
			header: [],
			headerSize: 0,
			lineStart: 0,
		};
	}

	#top(): Frame {
		return this.#frames[this.#frames.length - 1] as Frame;
	}

	write(chunk: Uint8Array): void {
		if (!this.done) this.#lines.write(chunk);
	}

	/** The end of the message: every open entity ends there. */
	end(): Entity {
		if (this.done) return this.root;
		this.#lines.end();
		const end = this.#lines.position;
		while (this.#frames.length > 0)
			this.#close(this.#frames.pop() as Frame, end, true);
		return this.root;
	}

	#line(line: Line): void {
		if (this.#delimiterLine(line)) {
			this.#count(line);
			return;
		}
		const top = this.#top();
		if (top.state === 'headers') {
			if (line.content.length === 0 && !line.truncated) {
				this.#headersDone(top, line.offset + line.length, line);
			} else this.#keepHeader(top, line);
		}
		this.#count(line);
	}

	#count(line: Line): void {
		if (line.breakLength > 0) this.#lineIndex++;
		this.#lastBreak = line.breakLength;
		this.#previousEmpty = line.content.length === 0 && !line.truncated;
	}

	#keepHeader(frame: Frame, line: Line): void {
		const size = line.content.length + 2;
		if (frame.headerSize + size > MAX_HEADER || size > this.#headerBudget)
			return;
		frame.header.push(line.content, CRLF);
		frame.headerSize += size;
		this.#headerBudget -= size;
	}

	#delimiterLine(line: Line): boolean {
		const { content } = line;
		if (line.truncated || content[0] !== 0x2d || content[1] !== 0x2d)
			return false;
		const after = content.subarray(2);
		for (let i = this.#frames.length - 1; i >= 0; i--) {
			const frame = this.#frames[i] as Frame;
			if (!frame.boundary || frame.state === 'epilogue') continue;
			const kind = delimiter(after, frame.boundary);
			if (!kind || (kind === 'open' && this.#parts >= MAX_PARTS)) continue;
			const end = Math.max(0, line.offset - this.#breakBefore(line));
			while (this.#frames.length - 1 > i)
				this.#close(this.#frames.pop() as Frame, end, false);
			if (kind === 'close') frame.state = 'epilogue';
			else this.#open(frame, line.offset + line.length);
			return true;
		}
		return false;
	}

	/** The line break the delimiter takes from the line before it. */
	#breakBefore(line: Line): number {
		return line.offset === 0 ? 0 : this.#lastBreak;
	}

	#open(parent: Frame, start: number): void {
		this.#parts++;
		parent.state = 'preamble';
		const child = newEntity(start);
		parent.entity.children.push(child);
		const digest = parent.entity.contentType.mediaType === 'multipart/digest';
		this.#frames.push(this.#frame(child, parent.depth + 1, digest));
	}

	#headersDone(frame: Frame, bodyStart: number, line: Line): void {
		const { entity } = frame;
		entity.headers = parseHeaderBlock(join(frame.header));
		frame.header = [];
		const type = entity.headers.get('content-type');
		entity.contentType =
			type === undefined && frame.inDigest
				? DIGEST_DEFAULT
				: parseContentType(type);
		entity.bodyStart = bodyStart;
		frame.lineStart = this.#lineIndex + (line.breakLength > 0 ? 1 : 0);
		frame.state = 'body';
		if (frame === this.#frames[0] && this.#headerOnly) this.done = true;
		if (frame.depth >= MAX_DEPTH) return;
		const { contentType } = entity;
		const boundary = contentType.parameters['boundary'];
		if (contentType.type === 'multipart' && boundary) {
			frame.boundary = new TextEncoder().encode(boundary);
			frame.state = 'preamble';
		} else if (isMessage(entity)) {
			frame.state = 'message';
			const inner = newEntity(bodyStart);
			entity.message = inner;
			this.#frames.push(this.#frame(inner, frame.depth + 1, false));
		}
	}

	#close(frame: Frame, at: number, atEnd: boolean): void {
		const { entity } = frame;
		if (frame.state === 'headers')
			this.#headersDone(frame, at, { breakLength: 0 } as Line);
		entity.end = Math.max(entity.bodyStart, at);
		if (entity.end === entity.bodyStart) return;
		const finished = this.#lineIndex - frame.lineStart;
		entity.lines = atEnd
			? finished + (this.#trailing ? 1 : 0)
			: finished - (this.#previousEmpty ? 1 : 0);
	}

	/** The message ends with a line that has no line break. */
	get #trailing(): boolean {
		return this.#lines.position > 0 && this.#lastBreak === 0;
	}
}

const CRLF = new Uint8Array([0x0d, 0x0a]);

/** Reads a stored message's structure from its blob, streaming. */
export async function scanStructure(
	blob: Blob,
	headerOnly = false,
): Promise<Entity> {
	const scanner = new StructureScanner(headerOnly);
	const reader = blob.stream().getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || scanner.done) break;
			scanner.write(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return scanner.end();
}
