import {
	applyAttempt,
	checkClaim,
	checkList,
	checkMaxItems,
	checkNewItem,
	checkOwner,
	checkResult,
	checkTime,
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
import { masked } from '../masked';
import { isStorable } from '../text';
import { type Connection, connect, type Keys } from './connect';
import { fieldsOf, isId, itemOf, outcomeOf, time } from './items';
import type { RedisQueueClient, RedisQueueStoreOptions } from './options';
import { checkLayout, run } from './run';
import {
	ADD,
	CANCEL,
	CLAIM,
	COMPLETE,
	LIST,
	RENEW,
	RESCHEDULE,
	type Script,
} from './scripts';

/**
 * A `QueueStore` on Redis through Bun's own `Bun.RedisClient`: several
 * instances, on one machine or many, share one queue. Every operation
 * that writes is one Lua script, which Redis runs whole, so two
 * instances never take the same item. The due items are in sorted sets,
 * each item a hash, its message a string written byte for byte. One
 * Redis, or a primary with replicas — not Redis Cluster.
 */
export class RedisQueueStore implements QueueStore {
	readonly #client: RedisQueueClient;
	readonly #owned: boolean;
	readonly #keys: Keys;
	readonly #password: string;
	#ready: Promise<void> | undefined;
	#closed = false;

	private constructor({ client, owned, keys, password }: Connection) {
		this.#client = client;
		this.#owned = owned;
		this.#keys = keys;
		this.#password = password;
	}

	/** Checks the options; connects to nothing until the first call. What is wrong is `INVALID`. */
	static open(options: RedisQueueStoreOptions): RedisQueueStore {
		return new RedisQueueStore(connect(options));
	}

	/** Closes the client the store opened for a URL, never one it was given; closing twice is fine. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#owned) await this.#client.close();
	}

	/**
	 * Reads the layout version, writing it on a new queue; once per
	 * store. A failure is `INVALID`, and the next call tries again.
	 */
	#setUp(): Promise<void> {
		this.#ready ??= checkLayout(this.#client, this.#keys).catch((error) => {
			this.#ready = undefined;
			if (error instanceof QueueError) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			throw new QueueError(
				'INVALID',
				`The Redis queue cannot be set up: ${masked(reason, this.#password)}`,
			);
		});
		return this.#ready;
	}

	/** The client, once the layout is checked; `CLOSED` after `close()`. */
	async #redis(): Promise<RedisQueueClient> {
		if (this.#closed) throw closed();
		await this.#setUp();
		return this.#client;
	}

	async #run(script: Script, keys: string[], args: (string | Uint8Array)[]) {
		const client = await this.#redis();
		return run(client, script, keys, [this.#keys.prefix, ...args]);
	}

	async add(item: NewQueueItem, options: AddOptions = {}): Promise<QueueItem> {
		checkNewItem(item);
		const max = checkMaxItems(options.maxItems);
		const added = newItem(crypto.randomUUID(), item);
		const k = this.#keys;
		const reply = (await this.#run(
			ADD,
			[k.items, k.ready, k.seq],
			[
				added.id,
				added.from,
				JSON.stringify(added.recipients),
				`${added.size}`,
				time(added.createdAt),
				item.message,
				max === undefined ? '' : `${max}`,
			],
		)) as string[];
		if (reply[0] === 'full') {
			throw new QueueError(
				'QUEUE_FULL',
				`The queue holds ${reply[1]} items, its limit`,
			);
		}
		return added;
	}

	async get(id: string): Promise<QueueItem | undefined> {
		if (!isId(id)) return undefined;
		const client = await this.#redis();
		const fields = fieldsOf(
			await client.send('HGETALL', [`${this.#keys.prefix}item:${id}`]),
		);
		return fields ? itemOf(fields) : undefined;
	}

	async list(options?: QueueListOptions): Promise<QueueItem[]> {
		const { offset, limit } = checkList(options);
		const pages = (await this.#run(
			LIST,
			[this.#keys.items],
			[`${offset}`, `${offset + limit - 1}`],
		)) as unknown[];
		return pages.flatMap((reply) => {
			const fields = fieldsOf(reply);
			return fields ? [itemOf(fields)] : [];
		});
	}

	async count(): Promise<number> {
		const client = await this.#redis();
		return Number(await client.send('ZCARD', [this.#keys.items]));
	}

	async readMessage(id: string): Promise<Uint8Array | undefined> {
		if (!isId(id)) return undefined;
		const client = await this.#redis();
		const bytes = await client.getBuffer(`${this.#keys.prefix}message:${id}`);
		return bytes === null ? undefined : new Uint8Array(bytes);
	}

	async claim(request: ClaimRequest): Promise<QueueItem | undefined> {
		checkClaim(request);
		const { owner, now, leaseMs } = request;
		const k = this.#keys;
		const fields = fieldsOf(
			await this.#run(
				CLAIM,
				[k.ready, k.leases, k.items],
				[owner, time(now), time(now + leaseMs)],
			),
		);
		return fields ? itemOf(fields) : undefined;
	}

	async renew(id: string, owner: string, expiresAt: number): Promise<boolean> {
		checkOwner(owner);
		checkTime('expiresAt', expiresAt);
		if (!isId(id)) return false;
		const k = this.#keys;
		const done = await this.#run(
			RENEW,
			[k.leases],
			[id, owner, time(expiresAt)],
		);
		return Number(done) === 1;
	}

	async complete(
		id: string,
		owner: string,
		result: AttemptResult,
	): Promise<QueueItem | undefined> {
		checkOwner(owner);
		checkResult(result);
		if (!isId(id)) return undefined;
		const k = this.#keys;
		const client = await this.#redis();
		for (let read = 0; read < MAX_READS; read++) {
			const fields = fieldsOf(
				await client.send('HGETALL', [`${k.prefix}item:${id}`]),
			);
			if (!fields || fields['owner'] !== owner) return undefined;
			const rev = fields['rev']; // none: damaged by hand, nothing recorded
			if (rev === undefined) return undefined;
			const item = applyAttempt(itemOf(fields), result);
			const done = Number(
				await this.#run(
					COMPLETE,
					[k.items, k.ready, k.leases],
					[id, owner, rev, ...outcomeOf(item)],
				),
			);
			if (done === 1) return item;
			if (done === 0) return undefined;
		}
		return undefined; // outrun MAX_READS times: told as a lease lost
	}

	async reschedule(id: string, at: number, owner?: string): Promise<boolean> {
		checkTime('at', at);
		// As PostgreSQL: an id no store could hold is unknown before the owner is checked.
		if (!isStorable(id)) return false;
		if (owner !== undefined) checkOwner(owner);
		if (!isId(id)) return false;
		const k = this.#keys;
		const done = await this.#run(
			RESCHEDULE,
			[k.items, k.ready, k.leases],
			[id, time(at), owner ?? ''],
		);
		return Number(done) === 1;
	}

	async cancel(id: string): Promise<QueueItem | undefined> {
		if (!isId(id)) return undefined;
		const k = this.#keys;
		const fields = fieldsOf(
			await this.#run(CANCEL, [k.items, k.ready, k.leases], [id]),
		);
		return fields ? itemOf(fields) : undefined;
	}
}

/** How often `complete` reads an item, another outcome recorded since each read. */
const MAX_READS = 8;

const closed = () => new QueueError('CLOSED', 'The queue store is closed');
