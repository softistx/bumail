import { join } from '../encoding/bytes';
import { decodeCharset } from '../encoding/charset';
import { decodeTransfer } from '../encoding/transfer';
import type { MessageHeaders } from '../headers/fields';
import {
	type ContentDisposition,
	type ContentType,
	parseContentDisposition,
} from '../headers/parameters';
import { MimeParser } from './stream';
import type { MimeEvent, MimeParserOptions, PartInfo } from './types';

/** A part of a parsed message, the message itself included. */
export class MimePart {
	readonly path: string;
	readonly headers: MessageHeaders;
	readonly contentType: ContentType;
	/** The children of a multipart, in order; empty for any other part. */
	readonly children: MimePart[] = [];
	/** The body as written, still in its transfer encoding; empty for a multipart. */
	raw: Uint8Array = new Uint8Array(0);

	constructor(info: PartInfo) {
		this.path = info.path;
		this.headers = info.headers;
		this.contentType = info.contentType;
	}

	/** The `Content-Disposition`, when the part has one. */
	get disposition(): ContentDisposition | undefined {
		const value = this.headers.get('content-disposition');
		return value === undefined ? undefined : parseContentDisposition(value);
	}

	/** The file name: the disposition's `filename`, else the content type's `name`. */
	get filename(): string | undefined {
		return (
			this.disposition?.parameters['filename'] ??
			this.contentType.parameters['name']
		);
	}

	/** The `Content-ID`, without its angle brackets. */
	get contentId(): string | undefined {
		return this.headers.get('content-id')?.trim().replace(/^<|>$/g, '');
	}

	/** The body decoded from its `Content-Transfer-Encoding`. */
	get content(): Uint8Array {
		return decodeTransfer(
			this.raw,
			this.headers.get('content-transfer-encoding'),
		);
	}

	/** The body decoded to text, in its `charset` (UTF-8 when it names none). */
	get text(): string {
		return decodeCharset(
			this.content,
			this.contentType.parameters['charset'] ?? 'utf-8',
		);
	}

	/** This part and every part inside it, depth first. */
	*walk(): Generator<MimePart> {
		yield this;
		for (const child of this.children) yield* child.walk();
	}
}

/**
 * Parses a whole message into a tree of parts. For a message too large to
 * hold, use `MimeParser` or `parseMimeStream`, which never keep a body.
 */
export function parseMessage(
	message: Uint8Array | string,
	options?: MimeParserOptions,
): MimePart {
	const bytes =
		typeof message === 'string' ? new TextEncoder().encode(message) : message;
	const parser = new MimeParser(options);
	const stack: MimePart[] = [];
	const chunks = new Map<MimePart, Uint8Array[]>();
	let root: MimePart | undefined;
	const apply = (events: readonly MimeEvent[]) => {
		for (const event of events) {
			if (event.type === 'headers') {
				const part = new MimePart(event.part);
				stack[stack.length - 1]?.children.push(part);
				root ??= part;
				stack.push(part);
				chunks.set(part, []);
			} else if (event.type === 'body') {
				chunks.get(stack[stack.length - 1] as MimePart)?.push(event.data);
			} else {
				const part = stack.pop() as MimePart;
				const parts = chunks.get(part) ?? [];
				part.raw = parts.length === 1 ? (parts[0] as Uint8Array) : join(parts);
				chunks.delete(part);
			}
		}
	};
	apply(parser.write(bytes));
	apply(parser.end());
	return root as MimePart;
}

/** What a reader shows of a message: its text, its HTML, and its attachments. */
export interface MessageContent {
	readonly text?: string;
	readonly html?: string;
	/** Every part that is not the text or the HTML body: files, inline images, nested messages. */
	readonly attachments: readonly MimePart[];
}

function isAttachment(part: MimePart): boolean {
	return part.disposition?.type === 'attachment';
}

/**
 * The text and HTML bodies of a message and its attachments. In a
 * `multipart/alternative` the last part of each kind wins, as RFC 2046
 * §5.1.4 orders them from plainest to richest; outside one, the first text
 * and the first HTML part not marked as attachments are the bodies.
 */
export function extractContent(root: MimePart): MessageContent {
	let text: string | undefined;
	let html: string | undefined;
	const attachments: MimePart[] = [];
	const visit = (part: MimePart, alternative: boolean) => {
		if (part.contentType.type === 'multipart') {
			const isAlternative = part.contentType.subtype === 'alternative';
			for (const child of part.children) visit(child, isAlternative);
			return;
		}
		const type = part.contentType.mediaType;
		if (
			!isAttachment(part) &&
			type === 'text/plain' &&
			(alternative || text === undefined)
		) {
			text = part.text;
		} else if (
			!isAttachment(part) &&
			type === 'text/html' &&
			(alternative || html === undefined)
		) {
			html = part.text;
		} else {
			attachments.push(part);
		}
	};
	visit(root, false);
	return {
		...(text === undefined ? {} : { text }),
		...(html === undefined ? {} : { html }),
		attachments,
	};
}
