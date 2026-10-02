import type { MessageHeaders } from '../headers/fields';
import type { ContentType } from '../headers/parameters';

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
 * that is not multipart — its body, still in its transfer encoding, in at
 * most one event per part per `write`, then its end. A multipart's children come
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
	 * waiting for its end. Default 64 KiB; at least 1000, so a delimiter line
	 * is always read whole.
	 */
	readonly maxLineBytes?: number;
	/**
	 * How many parts a message may hold, nested ones included, before the
	 * parser throws. Default 1000.
	 */
	readonly maxParts?: number;
}
