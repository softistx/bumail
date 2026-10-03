import {
	type ContentType,
	createTransferDecoder,
	MessageHeaders,
	MimeError,
	type MimeEvent,
	MimeParser,
	parseContentType,
	type TransferDecoder,
} from '@bumail/mime';

/** A part of a stored email, as Email/get describes it. */
export interface Part {
	/** IMAP's numbering (RFC 9051 §6.4.5): `''` for the message itself. */
	readonly path: string;
	readonly headers: MessageHeaders;
	readonly contentType: ContentType;
	readonly children: Part[];
	/** The body's size once its transfer encoding is decoded. */
	size: number;
	/** The start of a text body, decoded from its transfer encoding, at most what was asked. */
	readonly kept: Uint8Array[];
	keptSize: number;
}

/** What a parse keeps: of each text part, of every part, and of one part by its path. */
export interface ParseOptions {
	/** Stop at the end of the message's own header. */
	readonly headerOnly?: boolean;
	/** Bytes kept of each text/* part. Default 0. */
	readonly keepText?: number;
	/** Bytes kept at most, all parts together. */
	readonly budget?: { left: number };
	/** Keep this part's body, whatever its type, up to `keepPart` bytes. */
	readonly part?: string;
	readonly keepPart?: number;
}

interface Open {
	readonly part: Part;
	readonly decoder: TransferDecoder;
	readonly keep: number;
}

function newPart(info: {
	path: string;
	headers: MessageHeaders;
	contentType: ContentType;
}): Part {
	return { ...info, children: [], size: 0, kept: [], keptSize: 0 };
}

/** An email the parser refused: one opaque part of its whole size. */
function opaque(size: number): Part {
	const part = newPart({
		path: '',
		headers: new MessageHeaders(),
		contentType: parseContentType('application/octet-stream'),
	});
	part.size = size;
	return part;
}

class Builder {
	root: Part | undefined;
	readonly #stack: Open[] = [];
	readonly #options: ParseOptions;

	constructor(options: ParseOptions) {
		this.#options = options;
	}

	#keepFor(part: Part): number {
		const { keepText = 0, part: wanted, keepPart = 0 } = this.#options;
		if (wanted !== undefined)
			return part.path === wanted || (wanted === '1' && part.path === '')
				? keepPart
				: 0;
		return part.contentType.type === 'text' ? keepText : 0;
	}

	#keep(open: Open, bytes: Uint8Array): void {
		const { part } = open;
		part.size += bytes.length;
		const budget = this.#options.budget;
		const room = Math.min(
			open.keep - part.keptSize,
			budget?.left ?? Number.POSITIVE_INFINITY,
		);
		if (room <= 0 || bytes.length === 0) return;
		const taken = bytes.length > room ? bytes.slice(0, room) : bytes.slice();
		part.kept.push(taken);
		part.keptSize += taken.length;
		if (budget) budget.left -= taken.length;
	}

	apply(events: readonly MimeEvent[]): void {
		for (const event of events) {
			if (event.type === 'headers') {
				const part = newPart(event.part);
				this.#stack.at(-1)?.part.children.push(part);
				this.root ??= part;
				const encoding = part.headers.get('content-transfer-encoding');
				this.#stack.push({
					part,
					decoder: createTransferDecoder(encoding),
					keep: this.#keepFor(part),
				});
			} else if (event.type === 'body') {
				const open = this.#stack.at(-1) as Open;
				this.#keep(open, open.decoder.write(event.data));
			} else {
				const open = this.#stack.pop() as Open;
				this.#keep(open, open.decoder.end());
			}
		}
	}
}

/**
 * Reads a stored email once, streaming, into its tree of parts: headers,
 * types and decoded sizes, keeping only what `options` asks of the bodies.
 * An email the MIME parser refuses — too many parts, a header too large —
 * reads as one opaque part.
 */
export async function parseEmail(
	blob: Blob,
	options: ParseOptions = {},
): Promise<Part> {
	const parser = new MimeParser();
	const builder = new Builder(options);
	const reader = blob.stream().getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			builder.apply(parser.write(value));
			if (options.headerOnly && builder.root !== undefined) return builder.root;
		}
		builder.apply(parser.end());
	} catch (error) {
		if (error instanceof MimeError) return opaque(blob.size);
		throw error;
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return builder.root ?? opaque(blob.size);
}

/** Every part, depth first. */
export function* walk(part: Part): Generator<Part> {
	yield part;
	for (const child of part.children) yield* walk(child);
}

/** The JMAP partId of a part that is not multipart: its path, `1` for a message that is not. */
export const partIdOf = (part: Part): string =>
	part.path === '' ? '1' : part.path;
