import { QueueError } from '../errors';
import type { Collections } from './connect';
import type { MongoQueueCollection, MongoQueueDocument } from './options';

/**
 * `maxItems` without a transaction: an item added with it takes a
 * **place**, its `slot`, a number below `maxItems` that a unique index
 * lets one item hold at a time. Two adds racing for the last place both
 * insert, and the index refuses the second, so the items added with
 * `maxItems` never outnumber it — and a place is free again the moment
 * its item's document is deleted, in that same write, so no count drifts
 * when an instance dies between two writes, as a counter document kept
 * beside the items would.
 *
 * The place tried first is the add's sequence number modulo `maxItems`:
 * items leave a queue roughly in the order they came, so the place of the
 * item added `maxItems` adds ago is most likely free. Taken, the add
 * draws another number, a few times, then reads the places from the
 * index for the lowest free one. Each try first counts the items, so an
 * add refused is refused with the count.
 */

/** Tries by sequence number before the places are read. */
const RING_TRIES = 4;

/** Tries in all: each one lost means another add took a place meanwhile. */
const MAX_TRIES = 32;

/** `QUEUE_FULL`, with the count read. */
export const full = (n: number) =>
	new QueueError('QUEUE_FULL', `The queue holds ${n} items, its limit`);

/** Whether the insert lost its place to another add: a duplicate key in the place index. */
function isPlaceTaken(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { code, keyPattern, message } = error as {
		code?: unknown;
		keyPattern?: unknown;
		message?: unknown;
	};
	if (code !== 11000) return false;
	if (typeof keyPattern === 'object' && keyPattern !== null) {
		return 'slot' in keyPattern;
	}
	return typeof message === 'string' && message.includes('bumail_slot');
}

/** The lowest place below `max` no item holds, read from the place index; `undefined` when every one is held. */
async function lowestFree(
	items: MongoQueueCollection,
	max: number,
): Promise<number | undefined> {
	const held = await items
		.find(
			{ slot: { $exists: true, $lt: max } },
			{ sort: { slot: 1 }, projection: { _id: 0, slot: 1 } },
		)
		.toArray();
	let place = 0;
	for (const doc of held) {
		if (doc['slot'] !== place) break;
		place++;
	}
	return place < max ? place : undefined;
}

/**
 * Inserts `doc` holding a place below `max`, or throws `QUEUE_FULL` with
 * the count when the queue holds `max` items already. `nextSeq` draws
 * another sequence number, which the document takes with its new place.
 */
export async function insertPlaced(
	{ items }: Collections,
	doc: MongoQueueDocument & { readonly seq: number },
	max: number,
	nextSeq: () => Promise<number>,
): Promise<void> {
	let seq = doc.seq;
	for (let tries = 0; tries < MAX_TRIES; tries++) {
		const n = await items.countDocuments({});
		if (n >= max) throw full(n);
		if (tries > 0 && tries < RING_TRIES) seq = await nextSeq();
		const slot = tries < RING_TRIES ? seq % max : await lowestFree(items, max);
		// Every place held, yet fewer items than `max`: some leave meanwhile.
		if (slot === undefined) continue;
		try {
			await items.insertOne({ ...doc, seq, slot });
			return;
		} catch (error) {
			if (!isPlaceTaken(error)) throw error;
		}
	}
	throw full(await items.countDocuments({}));
}
