import type { Message } from '@bumail/store';
import {
	filterHeader,
	needsParts,
	type Section,
	select,
} from '../message/section';
import { type Entity, scanStructure } from '../message/structure';
import type { Connection } from '../server/connection';
import type { Partial } from './items';

/** The most of one header block read to filter its fields. */
const MAX_HEADER_READ = 256 * 1024;

/**
 * One message's content, read only as far as the items asked need it: the
 * blob, its own header, its whole structure — each at most once.
 */
export class MessageContent {
	readonly #connection: Connection;
	readonly message: Message;
	#blob: Promise<Blob | undefined> | undefined;
	#header: Promise<Entity | undefined> | undefined;
	#structure: Promise<Entity | undefined> | undefined;

	constructor(connection: Connection, message: Message) {
		this.#connection = connection;
		this.message = message;
	}

	blob(): Promise<Blob | undefined> {
		this.#blob ??= this.#connection.settings.store.readContent(
			this.#connection.accountId,
			this.message.blobId,
		);
		return this.#blob;
	}

	/** The message's own header, and where its body starts; its parts are not read. */
	header(): Promise<Entity | undefined> {
		if (this.#structure) return this.#structure;
		this.#header ??= this.blob().then(async (blob) => {
			if (!blob) return undefined;
			const root = await scanStructure(blob, true);
			root.end = blob.size;
			return root;
		});
		return this.#header;
	}

	/** The whole tree of parts, the whole message read once. */
	structure(): Promise<Entity | undefined> {
		this.#structure ??= this.blob().then((blob) =>
			blob ? scanStructure(blob) : undefined,
		);
		return this.#structure;
	}

	/** What a section names: bytes to send, or `undefined` for NIL. */
	async section(section: Section): Promise<Blob | Uint8Array | undefined> {
		const blob = await this.blob();
		if (!blob) return undefined;
		if (section.path.length === 0 && !section.text) return blob;
		const root = needsParts(section)
			? await this.structure()
			: await this.header();
		const selection = root && select(root, section);
		if (!selection) return undefined;
		if ('range' in selection)
			return blob.slice(selection.range.start, selection.range.end);
		const { start, end } = selection.header;
		const block = await blob
			.slice(start, Math.min(end, start + MAX_HEADER_READ))
			.bytes();
		return filterHeader(block, selection.fields, selection.not);
	}
}

/** `<origin.length>` of what a section names; past its end, nothing. */
export function partOf(
	data: Blob | Uint8Array,
	partial: Partial | undefined,
): Blob | Uint8Array {
	if (!partial) return data;
	const end = partial.origin + partial.length;
	return data instanceof Blob
		? data.slice(partial.origin, end)
		: data.subarray(partial.origin, end);
}
