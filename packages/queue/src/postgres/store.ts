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
import { masked } from '../masked';
import { isStorable } from '../text';
import { type Connection, connect, type Tables } from './connect';
import { writing, written } from './isolation';
import type { PostgresClient, PostgresQueueStoreOptions } from './options';
import { type ItemRow, itemOf, rowsOf } from './rows';
import { migrate } from './schema';
import { type Statements, statementsOf } from './statements';

export type {
	PostgresClient,
	PostgresQueryable,
	PostgresQueueStoreOptions,
} from './options';

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * A `QueueStore` on PostgreSQL through Bun's own `Bun.SQL`: several
 * instances, on one machine or many, share one queue. A claim is one
 * `UPDATE … RETURNING` whose item a `SELECT … FOR UPDATE SKIP LOCKED`
 * picks, so two instances never take the same item, and none waits on an
 * item another is taking. Messages live in a table of their own, dropped
 * with their item. The tables are made, or brought up to date, by
 * `migrate()`, or by the first call that needs them.
 */
export class PostgresQueueStore implements QueueStore {
	readonly #client: PostgresClient;
	readonly #owned: boolean;
	readonly #tables: Tables;
	readonly #q: Statements;
	readonly #password: string;
	#migrated: Promise<void> | undefined;
	#closed = false;

	private constructor({ client, owned, tables, password }: Connection) {
		this.#client = client;
		this.#owned = owned;
		this.#tables = tables;
		this.#password = password;
		this.#q = statementsOf(tables);
	}

	/** Checks the options; connects to nothing until the first call. What is wrong is `INVALID`. */
	static open(options: PostgresQueueStoreOptions): PostgresQueueStore {
		return new PostgresQueueStore(connect(options));
	}

	/**
	 * Makes the tables, or brings them to the last migration; once per
	 * store, and safe while other instances do the same. A failure is
	 * `INVALID`, and the next call tries again.
	 */
	migrate(): Promise<void> {
		if (this.#closed) return Promise.reject(closed());
		this.#migrated ??= migrate(this.#client, this.#tables).catch((error) => {
			this.#migrated = undefined;
			if (error instanceof QueueError) throw error;
			throw new QueueError(
				'INVALID',
				`The PostgreSQL queue cannot be set up: ${masked(messageOf(error), this.#password)}`,
			);
		});
		return this.#migrated;
	}

	/** Closes the client the store opened for a URL, never one it was given; closing twice is fine. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#owned) await this.#client.close();
	}

	/** The client, once the tables are there; `CLOSED` after `close()`. */
	async #sql(): Promise<PostgresClient> {
		if (this.#closed) throw closed();
		await this.migrate();
		return this.#client;
	}

	async #rows<T>(query: string, values: unknown[] = []): Promise<T[]> {
		return rowsOf<T>((await this.#sql()).unsafe(query, values));
	}

	/** One statement that writes, at READ COMMITTED; its rows. */
	async #written<T>(query: string, values: unknown[] = []): Promise<T[]> {
		return written<T>(await this.#sql(), query, values);
	}

	async add(item: NewQueueItem, options: AddOptions = {}): Promise<QueueItem> {
		checkNewItem(item);
		const max = checkMaxItems(options.maxItems);
		const added = newItem(crypto.randomUUID(), item);
		const values = [
			added.id,
			added.from,
			JSON.stringify(added.recipients),
			added.size,
			added.createdAt,
			item.message,
		];
		const q = this.#q;
		if (max === undefined) {
			await this.#written(q.insert, values);
			return added;
		}
		// Adds that count wait on one lock, so two never both take the last place.
		await writing(await this.#sql(), async (tx) => {
			await tx.unsafe(q.lockAdds);
			const [row] = await rowsOf<{ n: number }>(tx.unsafe(q.count));
			const n = row?.n ?? 0;
			if (n >= max) {
				throw new QueueError(
					'QUEUE_FULL',
					`The queue holds ${n} items, its limit`,
				);
			}
			await tx.unsafe(q.insert, values);
		});
		return added;
	}

	async get(id: string): Promise<QueueItem | undefined> {
		if (!isStorable(id)) return undefined;
		const [row] = await this.#rows<ItemRow>(this.#q.get, [id]);
		return row ? itemOf(row) : undefined;
	}

	async list(options?: QueueListOptions): Promise<QueueItem[]> {
		const { offset, limit } = checkList(options);
		const rows = await this.#rows<ItemRow>(this.#q.list, [limit, offset]);
		return rows.map(itemOf);
	}

	async count(): Promise<number> {
		const [row] = await this.#rows<{ n: number }>(this.#q.count);
		return row?.n ?? 0;
	}

	async readMessage(id: string): Promise<Uint8Array | undefined> {
		if (!isStorable(id)) return undefined;
		const [row] = await this.#rows<{ content: Uint8Array }>(this.#q.message, [
			id,
		]);
		return row ? new Uint8Array(row.content) : undefined;
	}

	async claim(request: ClaimRequest): Promise<QueueItem | undefined> {
		checkClaim(request);
		const { owner, now, leaseMs } = request;
		const [row] = await this.#written<ItemRow>(this.#q.claim, [
			owner,
			now,
			now + leaseMs,
		]);
		return row ? itemOf(row) : undefined;
	}

	async renew(id: string, owner: string, expiresAt: number): Promise<boolean> {
		checkOwner(owner);
		checkTime('expiresAt', expiresAt);
		if (!isStorable(id)) return false;
		const rows = await this.#written(this.#q.renew, [expiresAt, id, owner]);
		return rows.length > 0;
	}

	async complete(
		id: string,
		owner: string,
		result: AttemptResult,
	): Promise<QueueItem | undefined> {
		checkOwner(owner);
		checkResult(result);
		if (!isStorable(id)) return undefined;
		const q = this.#q;
		let done: QueueItem | undefined;
		await writing(await this.#sql(), async (tx) => {
			const [row] = await rowsOf<ItemRow>(tx.unsafe(q.held, [id, owner]));
			if (!row) return;
			const item = applyAttempt(itemOf(row), result);
			if (isDone(item)) {
				await tx.unsafe(q.drop, [id]);
			} else {
				await tx.unsafe(q.record, [
					id,
					JSON.stringify(item.recipients),
					item.nextAttemptAt,
					item.attempts,
					item.delayNotified,
				]);
			}
			done = item;
		});
		return done;
	}

	async reschedule(id: string, at: number, owner?: string): Promise<boolean> {
		checkTime('at', at);
		if (!isStorable(id)) return false;
		if (owner === undefined) {
			return (await this.#written(this.#q.moveDue, [at, id])).length > 0;
		}
		checkOwner(owner);
		return (await this.#written(this.#q.giveBack, [at, id, owner])).length > 0;
	}

	async cancel(id: string): Promise<QueueItem | undefined> {
		// An id PostgreSQL cannot hold is one no item has.
		if (!isStorable(id)) return undefined;
		const [row] = await this.#written<ItemRow>(this.#q.drop, [id]);
		return row ? itemOf(row) : undefined;
	}
}

const closed = () => new QueueError('CLOSED', 'The queue store is closed');
