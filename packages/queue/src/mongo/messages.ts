import { QueueError } from '../errors';
import type { Collections } from './connect';
import { messageOf } from './documents';
import type { MongoQueueCollection } from './options';

/**
 * The messages collection: each message in chunks (`documents.ts` lays
 * them out), written before its item and dropped after it, so a message
 * is read only through an item that names it.
 */

/** The chunks of an item's message: their `_id`s are `<id>:<n>`, and `;` follows `:`. */
export const chunksFilter = (id: string) => ({
	_id: { $gte: `${id}:`, $lt: `${id};` },
});

/**
 * Drops a message's chunks once its item is gone, or was never written.
 * What a failure leaves is dangling: no item names it, so no read
 * returns it (the guide says how to clear it).
 */
export async function dropMessage(
	messages: MongoQueueCollection,
	id: string,
): Promise<void> {
	try {
		await messages.deleteMany(chunksFilter(id));
	} catch {
		// Dangling, never read.
	}
}

/**
 * Whether a failed write was refused for certain, written nothing: the
 * queue full, or the server's own answer to it. Not a write-concern
 * error, which answers a write that was applied, nor a connection lost
 * with the write on its way, which may have been.
 */
export function isRefused(error: unknown): boolean {
	if (error instanceof QueueError) return true;
	if (typeof error !== 'object' || error === null) return false;
	const { code, name } = error as { code?: unknown; name?: unknown };
	// A duplicate key may be the item's own insert, applied and retried.
	return (
		typeof code === 'number' &&
		code !== 11000 &&
		!(typeof name === 'string' && name.includes('WriteConcern')) &&
		!('writeConcernError' in error)
	);
}

/**
 * After an add's item insert failed: `true` when the item is there all
 * the same — the insert applied, its answer lost — or else the message
 * dropped when the insert was refused for certain, and left when it may
 * still apply, so no stored item ever loses its message.
 */
export async function settleFailedAdd(
	{ items, messages }: Collections,
	id: string,
	error: unknown,
): Promise<boolean> {
	if (isRefused(error)) {
		await dropMessage(messages, id);
		return false;
	}
	try {
		return (
			(await items.findOne({ _id: id }, { projection: { _id: 1 } })) !== null
		);
	} catch {
		return false; // unknown: the chunks stay, dangling at worst
	}
}

/** The message of the item `id`, whole, or `undefined` when the item is gone or its chunks are not all there. */
export async function readChunks(
	{ items, messages }: Collections,
	id: string,
): Promise<Uint8Array | undefined> {
	const doc = await items.findOne(
		{ _id: id },
		{ projection: { size: 1, chunks: 1 } },
	);
	if (!doc) return undefined;
	const chunks = await messages.find(chunksFilter(id)).toArray();
	if (chunks.length !== doc['chunks'] || typeof doc['size'] !== 'number') {
		return undefined;
	}
	chunks.sort((a, b) => Number(a['n']) - Number(b['n']));
	return messageOf(chunks, doc['size']);
}
