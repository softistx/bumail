import type { QueueItem, RecipientState } from '../contract/types';
import type { MongoQueueDocument } from './options';

/**
 * The documents of a MongoDB queue.
 *
 * An item is one document of the items collection, its `_id` the item's
 * id. Times are BSON doubles, written from the numbers JavaScript holds,
 * so each reads back exactly, fractions of a millisecond included — never
 * a BSON date, which keeps whole milliseconds only. A lease is `owner`
 * and `expiresAt`, both there or both gone.
 *
 * Its message is in the messages collection, in chunks of `CHUNK` bytes
 * at most, each a document `{ _id: '<id>:<n>', item, n, data }` whose
 * `data` is BSON binary: a message can be larger than the 16 MiB a
 * document holds.
 */

/** The bytes of one chunk of a message: well under BSON's 16 MiB a document. */
export const CHUNK = 4 * 1024 * 1024;

/**
 * The ids a store makes, `crypto.randomUUID()`'s. Any other id is one no
 * item has, so nothing a caller gives — an object such as `{ $ne: null }`
 * included — ever reaches a filter but an id.
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isId = (id: unknown): id is string =>
	typeof id === 'string' && ID.test(id);

/**
 * The recipients as a document holds them: written through JSON, as the
 * other stores do, so a field left `undefined` is left out rather than
 * written as `null`.
 */
export const recipientsDoc = (recipients: readonly RecipientState[]) =>
	JSON.parse(JSON.stringify(recipients)) as RecipientState[];

const text = (value: unknown): string =>
	typeof value === 'string' ? value : '';

const number = (value: unknown): number =>
	typeof value === 'number' ? value : Number.NaN;

/** The item a document holds. */
export function itemOf(doc: MongoQueueDocument): QueueItem {
	const recipients = Array.isArray(doc['recipients'])
		? (doc['recipients'] as RecipientState[])
		: [];
	const item: QueueItem = {
		id: text(doc['_id']),
		from: text(doc['from']),
		recipients,
		size: number(doc['size']),
		createdAt: number(doc['createdAt']),
		nextAttemptAt: number(doc['nextAttemptAt']),
		attempts: number(doc['attempts']),
		delayNotified: doc['delayNotified'] === true,
	};
	const owner = doc['owner'];
	const expiresAt = doc['expiresAt'];
	if (typeof owner !== 'string' || typeof expiresAt !== 'number') return item;
	return { ...item, lease: { owner, expiresAt } };
}

/** The chunk documents of a message. */
export function chunksOf(
	id: string,
	message: Uint8Array,
): MongoQueueDocument[] {
	const chunks: MongoQueueDocument[] = [];
	for (let n = 0; n * CHUNK < message.length; n++) {
		chunks.push({
			_id: `${id}:${n}`,
			item: id,
			n,
			data: message.subarray(n * CHUNK, (n + 1) * CHUNK),
		});
	}
	return chunks;
}

/**
 * The bytes of a chunk's `data`: the driver reads BSON binary as its
 * `Binary`, whose `buffer` holds the bytes up to `position`, or as a
 * `Buffer` when the client promotes them; anything else is no bytes.
 */
export function bytesOf(data: unknown): Uint8Array | undefined {
	if (data instanceof Uint8Array) return data;
	if (typeof data !== 'object' || data === null) return undefined;
	const { buffer, position } = data as { buffer?: unknown; position?: unknown };
	if (!(buffer instanceof Uint8Array) || typeof position !== 'number') {
		return undefined;
	}
	return buffer.subarray(0, position);
}

/**
 * The message from its chunks, in order, or `undefined` unless they are
 * every chunk of `size` bytes: one missing, or left by a write cut short,
 * makes a message no one should send.
 */
export function messageOf(
	chunks: readonly MongoQueueDocument[],
	size: number,
): Uint8Array | undefined {
	const out = new Uint8Array(size);
	let at = 0;
	for (const [n, chunk] of chunks.entries()) {
		const bytes = bytesOf(chunk['data']);
		if (chunk['n'] !== n || !bytes || at + bytes.length > size)
			return undefined;
		out.set(bytes, at);
		at += bytes.length;
	}
	return at === size ? out : undefined;
}
