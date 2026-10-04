import {
	applyAttempt,
	checkClaim,
	checkList,
	checkMaxItems,
	checkNewItem,
	checkOwner,
	checkResult,
	checkTime,
	isDone,
	newItem,
} from '../contract/checks';
import type { QueueStore } from '../contract/queue-store';
import type {
	AddOptions,
	AttemptResult,
	ClaimRequest,
	NewQueueItem,
	QueueItem,
	QueueListOptions,
} from '../contract/types';
import { QueueError } from '../errors';
import { isStorable } from '../text';
import {
	type Collections,
	type Connection,
	connect,
	type Names,
	reasonOf,
} from './connect';
import { chunksOf, isId, itemOf, messageOf, recipientsDoc } from './documents';
import { checkLayout } from './layout';
import type {
	MongoQueueCollection,
	MongoQueueDocument,
	MongoQueueStoreOptions,
} from './options';
import { full, insertPlaced } from './places';

export type {
	MongoQueueCollection,
	MongoQueueCollectionOptions,
	MongoQueueCursor,
	MongoQueueDb,
	MongoQueueDocument,
	MongoQueueStoreOptions,
} from './options';

/** The `_id` of the counter that orders items equally due, in the schema collection. */
const SEQ_ID = 'seq';

/** How often `complete` reads an item, another outcome recorded since each read. */
const MAX_READS = 8;

/** The chunks of an item's message: their `_id`s are `<id>:<n>`, and `;` follows `:`. */
const chunksFilter = (id: string) => ({
	_id: { $gte: `${id}:`, $lt: `${id};` },
});

const closed = () => new QueueError('CLOSED', 'The queue store is closed');

/**
 * A `QueueStore` on MongoDB, through a `Db` of the application's: several
 * instances, on one machine or many, share one queue. Every write that
 * decides — claim, renew, complete, reschedule, cancel — is one
 * `findOneAndUpdate` or `findOneAndDelete` on one item's document, whose
 * filter names the lease it needs, so MongoDB applies it whole and two
 * instances never take the same item. Messages are kept byte for byte,
 * as BSON binary, in chunks of their own; `maxItems` holds through a
 * unique index, without a transaction, so a standalone server works as
 * well as a replica set.
 */
export class MongoQueueStore implements QueueStore {
	readonly #c: Collections;
	readonly #names: Names;
	readonly #secret: string;
	#ready: Promise<void> | undefined;
	#closed = false;

	private constructor({ collections, names, secret }: Connection) {
		this.#c = collections;
		this.#names = names;
		this.#secret = secret;
	}

	/** Checks the options; connects to nothing until the first call. What is wrong is `INVALID`. */
	static open(options: MongoQueueStoreOptions): MongoQueueStore {
		return new MongoQueueStore(connect(options));
	}

	/** Marks the store closed; the client, the application's, stays open. Closing twice is fine. */
	async close(): Promise<void> {
		this.#closed = true;
	}

	/**
	 * Reads the layout version, and on a new queue makes the indexes and
	 * writes it; once per store. A failure is `INVALID`, and the next call
	 * tries again.
	 */
	#setUp(): Promise<void> {
		this.#ready ??= checkLayout(this.#c, this.#names).catch((error) => {
			this.#ready = undefined;
			if (error instanceof QueueError) throw error;
			throw new QueueError(
				'INVALID',
				`The MongoDB queue cannot be set up: ${reasonOf(error, this.#secret)}`,
			);
		});
		return this.#ready;
	}

	/** The collections, once the layout is checked; `CLOSED` after `close()`. */
	async #collections(): Promise<Collections> {
		if (this.#closed) throw closed();
		await this.#setUp();
		return this.#c;
	}

	async #nextSeq(): Promise<number> {
		const doc = await this.#c.schema.findOneAndUpdate(
			{ _id: SEQ_ID },
			{ $inc: { n: 1 } },
			{ upsert: true, returnDocument: 'after' },
		);
		const n = doc?.['n'];
		if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
			throw new QueueError(
				'INVALID',
				`The collection ${this.#names.schema} holds a sequence that is not a number`,
			);
		}
		return n;
	}

	/** Drops a message's chunks once its item is gone; what a failure leaves is never read. */
	async #dropMessage(messages: MongoQueueCollection, id: string) {
		try {
			await messages.deleteMany(chunksFilter(id));
		} catch {
			// Dangling: no item names them, so no read returns them (see the guide).
		}
	}

	async add(item: NewQueueItem, options: AddOptions = {}): Promise<QueueItem> {
		checkNewItem(item);
		const max = checkMaxItems(options.maxItems);
		const added = newItem(crypto.randomUUID(), item);
		const c = await this.#collections();
		// Full already: refused before the message is written. `insertPlaced` decides.
		if (max !== undefined) {
			const n = await c.items.countDocuments({});
			if (n >= max) throw full(n);
		}
		const chunks = chunksOf(added.id, item.message);
		const doc = {
			_id: added.id,
			seq: await this.#nextSeq(),
			from: added.from,
			recipients: recipientsDoc(added.recipients),
			size: added.size,
			createdAt: added.createdAt,
			nextAttemptAt: added.nextAttemptAt,
			attempts: 0,
			delayNotified: false,
			rev: 0,
			chunks: chunks.length,
		};
		// The message first: the item's insert is what makes it visible.
		try {
			if (chunks.length > 0) {
				await c.messages.insertMany(chunks, { ordered: true });
			}
			if (max === undefined) await c.items.insertOne(doc);
			else await insertPlaced(c, doc, max, () => this.#nextSeq());
		} catch (error) {
			await this.#dropMessage(c.messages, added.id);
			throw error;
		}
		return added;
	}

	async get(id: string): Promise<QueueItem | undefined> {
		if (!isId(id)) return undefined;
		const { items } = await this.#collections();
		const doc = await items.findOne({ _id: id });
		return doc ? itemOf(doc) : undefined;
	}

	async list(options?: QueueListOptions): Promise<QueueItem[]> {
		const { offset, limit } = checkList(options);
		const { items } = await this.#collections();
		const docs = await items
			.find({}, { sort: { nextAttemptAt: 1, seq: 1 }, skip: offset, limit })
			.toArray();
		return docs.map(itemOf);
	}

	async count(): Promise<number> {
		const { items } = await this.#collections();
		return items.countDocuments({});
	}

	async readMessage(id: string): Promise<Uint8Array | undefined> {
		if (!isId(id)) return undefined;
		const { items, messages } = await this.#collections();
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

	async claim(request: ClaimRequest): Promise<QueueItem | undefined> {
		checkClaim(request);
		const { owner, now, leaseMs } = request;
		const { items } = await this.#collections();
		// No lease, or one expired (`$not` matches no `expiresAt` too): the
		// earliest due, then the oldest, by the due index.
		const doc = await items.findOneAndUpdate(
			{ nextAttemptAt: { $lte: now }, expiresAt: { $not: { $gt: now } } },
			{ $set: { owner, expiresAt: now + leaseMs } },
			{ sort: { nextAttemptAt: 1, seq: 1 }, returnDocument: 'after' },
		);
		return doc ? itemOf(doc) : undefined;
	}

	async renew(id: string, owner: string, expiresAt: number): Promise<boolean> {
		checkOwner(owner);
		checkTime('expiresAt', expiresAt);
		if (!isId(id)) return false;
		const { items } = await this.#collections();
		const doc = await items.findOneAndUpdate(
			{ _id: id, owner },
			{ $set: { expiresAt } },
			{ returnDocument: 'after', projection: { _id: 1 } },
		);
		return doc !== null;
	}

	async complete(
		id: string,
		owner: string,
		result: AttemptResult,
	): Promise<QueueItem | undefined> {
		checkOwner(owner);
		checkResult(result);
		if (!isId(id)) return undefined;
		const { items, messages } = await this.#collections();
		for (let read = 0; read < MAX_READS; read++) {
			const doc = await items.findOne({ _id: id });
			if (!doc || doc['owner'] !== owner) return undefined;
			const rev = doc['rev']; // none: damaged by hand, nothing recorded
			if (typeof rev !== 'number') return undefined;
			const item = applyAttempt(itemOf(doc), result);
			// Only while the owner holds the lease, and no other outcome was recorded since the read.
			const held = { _id: id, owner, rev };
			if (isDone(item)) {
				if (await items.findOneAndDelete(held)) {
					await this.#dropMessage(messages, id);
					return item;
				}
				continue;
			}
			const recorded = await items.findOneAndUpdate(
				held,
				{
					$set: {
						recipients: recipientsDoc(item.recipients),
						nextAttemptAt: item.nextAttemptAt,
						attempts: item.attempts,
						delayNotified: item.delayNotified,
					},
					$unset: { owner: '', expiresAt: '' },
					$inc: { rev: 1 },
				},
				{ returnDocument: 'after', projection: { _id: 1 } },
			);
			if (recorded) return item;
		}
		return undefined; // outrun MAX_READS times: told as a lease lost
	}

	async reschedule(id: string, at: number, owner?: string): Promise<boolean> {
		checkTime('at', at);
		// As PostgreSQL: an id no store could hold is unknown before the owner is checked.
		if (typeof id !== 'string' || !isStorable(id)) return false;
		if (owner !== undefined) checkOwner(owner);
		if (!isId(id)) return false;
		const { items } = await this.#collections();
		const update: MongoQueueDocument =
			owner === undefined
				? { $set: { nextAttemptAt: at } }
				: {
						$set: { nextAttemptAt: at },
						$unset: { owner: '', expiresAt: '' },
					};
		const doc = await items.findOneAndUpdate(
			owner === undefined ? { _id: id } : { _id: id, owner },
			update,
			{ returnDocument: 'after', projection: { _id: 1 } },
		);
		return doc !== null;
	}

	async cancel(id: string): Promise<QueueItem | undefined> {
		if (!isId(id)) return undefined;
		const { items, messages } = await this.#collections();
		const doc = await items.findOneAndDelete({ _id: id });
		if (!doc) return undefined;
		await this.#dropMessage(messages, id);
		return itemOf(doc);
	}
}
