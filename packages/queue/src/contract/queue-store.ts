import type {
	AddOptions,
	AttemptResult,
	ClaimRequest,
	NewQueueItem,
	QueueItem,
	QueueListOptions,
} from './types';

/**
 * Where the queue keeps its items, made for several workers, in one
 * process or many, sharing one store. A worker **claims** a due item: it
 * gets a lease, an owner and an expiry, and no other worker gets the item
 * until the lease expires — a worker that crashed loses it then, and
 * another claims it. Its owner renews the lease while it delivers, records
 * the outcome with `complete`, which lets go of the lease, or gives the
 * item back with `reschedule`.
 *
 * An item whose every recipient is `delivered` or `failed` is done: the
 * store drops it, and its message, in the same step. Times are
 * milliseconds since the epoch, given by the caller: a store keeps no
 * clock. Nothing a store returns is shared with what it keeps.
 */
export interface QueueStore {
	/**
	 * Adds an item, due at once, with every recipient `pending`. With
	 * `maxItems`, refuses with `QUEUE_FULL` when the store holds that many
	 * already, in the same step as the add.
	 */
	add(item: NewQueueItem, options?: AddOptions): Promise<QueueItem>;

	/** The item, or `undefined` when there is none by that id (done, cancelled, or never added). */
	get(id: string): Promise<QueueItem | undefined>;

	/** The items, the next due first; done items are gone. */
	list(options?: QueueListOptions): Promise<QueueItem[]>;

	/** How many items the store holds. */
	count(): Promise<number>;

	/**
	 * The message of an item, or `undefined` once the item is gone. A
	 * store that holds the item but has lost its message gives `undefined`
	 * too: the queue then fails the item's pending recipients.
	 */
	readMessage(id: string): Promise<Uint8Array | undefined>;

	/**
	 * Takes the next item due at `now` — no lease, or a lease expired —
	 * and gives it a lease of `leaseMs` for `owner`, atomically: two
	 * claimers never take the same item. The earliest due goes first, then
	 * the oldest. `undefined` when nothing is due.
	 */
	claim(request: ClaimRequest): Promise<QueueItem | undefined>;

	/**
	 * Moves the lease's expiry, while `owner` still holds it. False when it
	 * does not: another worker claimed the item, or it is gone.
	 */
	renew(id: string, owner: string, expiresAt: number): Promise<boolean>;

	/**
	 * Records an attempt: each recipient's outcome, the next attempt and the
	 * count, and lets go of the lease — in one step, while `owner` holds it.
	 * Returns the item as it now stands, done (every recipient final, and
	 * the item dropped) or not; `undefined` when `owner` no longer holds it.
	 */
	complete(
		id: string,
		owner: string,
		result: AttemptResult,
	): Promise<QueueItem | undefined>;

	/**
	 * Moves the next attempt to `at`. With `owner`, only while that owner
	 * holds the lease, which it lets go of: a worker giving an item back.
	 * Without, whoever holds it keeps the lease: an admin's "retry now".
	 * False when the item is gone, or `owner` does not hold it.
	 */
	reschedule(id: string, at: number, owner?: string): Promise<boolean>;

	/** Drops an item and its message, leased or not; the item as it stood, or `undefined`. */
	cancel(id: string): Promise<QueueItem | undefined>;
}
