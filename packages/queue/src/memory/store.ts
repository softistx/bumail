import {
	applyAttempt,
	checkClaim,
	checkList,
	checkMaxItems,
	checkNewItem,
	checkOwner,
	checkResult,
	checkTime,
	claimable,
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

interface Entry {
	item: QueueItem;
	message: Uint8Array;
	/** The order items were added in: the oldest first among those equally due. */
	readonly seq: number;
}

/** The earliest due first, then the oldest. */
const byDue = (a: Entry, b: Entry) =>
	a.item.nextAttemptAt - b.item.nextAttemptAt || a.seq - b.seq;

/**
 * A `QueueStore` in memory: for specs, and for a single process that can
 * lose its queue on a restart. Every operation runs without awaiting, so
 * claims never interleave, and every item it returns is a copy.
 */
export class MemoryQueueStore implements QueueStore {
	readonly #entries = new Map<string, Entry>();
	#seq = 0;

	async add(item: NewQueueItem, options: AddOptions = {}): Promise<QueueItem> {
		checkNewItem(item);
		const max = checkMaxItems(options.maxItems);
		if (max !== undefined && this.#entries.size >= max) {
			throw new QueueError(
				'QUEUE_FULL',
				`The queue holds ${this.#entries.size} items, its limit`,
			);
		}
		const entry: Entry = {
			item: newItem(crypto.randomUUID(), item),
			message: item.message.slice(),
			seq: this.#seq++,
		};
		this.#entries.set(entry.item.id, entry);
		return structuredClone(entry.item);
	}

	async get(id: string): Promise<QueueItem | undefined> {
		const entry = this.#entries.get(id);
		return entry && structuredClone(entry.item);
	}

	async list(options?: QueueListOptions): Promise<QueueItem[]> {
		const { offset, limit } = checkList(options);
		return [...this.#entries.values()]
			.sort(byDue)
			.slice(offset, offset + limit)
			.map((entry) => structuredClone(entry.item));
	}

	async count(): Promise<number> {
		return this.#entries.size;
	}

	async readMessage(id: string): Promise<Uint8Array | undefined> {
		return this.#entries.get(id)?.message.slice();
	}

	async claim(request: ClaimRequest): Promise<QueueItem | undefined> {
		checkClaim(request);
		let next: Entry | undefined;
		for (const entry of this.#entries.values()) {
			if (!claimable(entry.item, request.now)) continue;
			if (!next || byDue(entry, next) < 0) next = entry;
		}
		if (!next) return undefined;
		next.item = {
			...next.item,
			lease: {
				owner: request.owner,
				expiresAt: request.now + request.leaseMs,
			},
		};
		return structuredClone(next.item);
	}

	/** The entry while `owner` holds its lease. */
	#held(id: string, owner: string): Entry | undefined {
		checkOwner(owner);
		const entry = this.#entries.get(id);
		return entry?.item.lease?.owner === owner ? entry : undefined;
	}

	async renew(id: string, owner: string, expiresAt: number): Promise<boolean> {
		checkTime('expiresAt', expiresAt);
		const entry = this.#held(id, owner);
		if (!entry) return false;
		entry.item = { ...entry.item, lease: { owner, expiresAt } };
		return true;
	}

	async complete(
		id: string,
		owner: string,
		result: AttemptResult,
	): Promise<QueueItem | undefined> {
		checkResult(result);
		const entry = this.#held(id, owner);
		if (!entry) return undefined;
		entry.item = applyAttempt(entry.item, result);
		if (isDone(entry.item)) this.#entries.delete(id);
		return structuredClone(entry.item);
	}

	async reschedule(id: string, at: number, owner?: string): Promise<boolean> {
		checkTime('at', at);
		const entry =
			owner === undefined ? this.#entries.get(id) : this.#held(id, owner);
		if (!entry) return false;
		if (owner === undefined) {
			entry.item = { ...entry.item, nextAttemptAt: at };
		} else {
			const { lease: _, ...rest } = entry.item;
			entry.item = { ...rest, nextAttemptAt: at };
		}
		return true;
	}

	async cancel(id: string): Promise<QueueItem | undefined> {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		this.#entries.delete(id);
		return structuredClone(entry.item);
	}
}
