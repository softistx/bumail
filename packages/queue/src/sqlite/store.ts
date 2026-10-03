import type { Database } from 'bun:sqlite';
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
import { openDatabase } from './open';
import type { SqliteQueueStoreOptions } from './options';
import { COLUMNS, type ItemRow, itemOf, stateOf } from './rows';

export type { SqliteQueueStoreOptions } from './options';

const DUE = `next_attempt_at <= $now
	AND (lease_owner IS NULL OR lease_expires_at <= $now)`;

/**
 * A `QueueStore` on `bun:sqlite`: one directory holding `queue.sqlite`,
 * which several processes on one machine may open together. Every
 * operation is one transaction — a claim is a single `UPDATE … RETURNING`
 * — so two workers never take the same item. Messages live in a table of
 * their own, dropped with their item.
 */
export class SqliteQueueStore implements QueueStore {
	readonly #db: Database;
	#closed = false;

	private constructor(db: Database) {
		this.#db = db;
	}

	/** Opens the store in `directory`, creating it if need be; what fails is `INVALID`. */
	static open(options: SqliteQueueStoreOptions): SqliteQueueStore {
		return new SqliteQueueStore(openDatabase(options));
	}

	/** Lets go of the database; closing twice is fine. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	get #open(): Database {
		if (this.#closed) {
			throw new QueueError('CLOSED', 'The queue store is closed');
		}
		return this.#db;
	}

	#row(id: string, owner?: string): ItemRow | null {
		const db = this.#open;
		if (owner === undefined) {
			return db
				.query<ItemRow, [string]>(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
				.get(id);
		}
		return db
			.query<ItemRow, [string, string]>(
				`SELECT ${COLUMNS} FROM items WHERE id = ? AND lease_owner = ?`,
			)
			.get(id, owner);
	}

	#write(item: QueueItem): void {
		this.#open
			.query(
				`UPDATE items SET recipients = $recipients,
				next_attempt_at = $next_attempt_at, attempts = $attempts,
				delay_notified = $delay_notified, lease_owner = $lease_owner,
				lease_expires_at = $lease_expires_at WHERE id = $id`,
			)
			.run(stateOf(item));
	}

	async add(item: NewQueueItem, options: AddOptions = {}): Promise<QueueItem> {
		checkNewItem(item);
		const max = checkMaxItems(options.maxItems);
		const db = this.#open;
		const added = newItem(crypto.randomUUID(), item);
		db.transaction(() => {
			if (max !== undefined) {
				const { n } = db
					.query<{ n: number }, []>('SELECT count(*) AS n FROM items')
					.get() as { n: number };
				if (n >= max) {
					throw new QueueError(
						'QUEUE_FULL',
						`The queue holds ${n} items, its limit`,
					);
				}
			}
			db.query(
				`INSERT INTO items (id, sender, recipients, size, created_at,
				next_attempt_at, attempts, delay_notified)
				VALUES ($id, $sender, $recipients, $size, $created_at,
				$next_attempt_at, 0, 0)`,
			).run({
				id: added.id,
				sender: added.from,
				recipients: JSON.stringify(added.recipients),
				size: added.size,
				created_at: added.createdAt,
				next_attempt_at: added.nextAttemptAt,
			});
			db.query('INSERT INTO messages (item_id, content) VALUES (?, ?)').run(
				added.id,
				item.message,
			);
		}).immediate();
		return added;
	}

	async get(id: string): Promise<QueueItem | undefined> {
		const row = this.#row(id);
		return row ? itemOf(row) : undefined;
	}

	async list(options?: QueueListOptions): Promise<QueueItem[]> {
		const { offset, limit } = checkList(options);
		return this.#open
			.query<ItemRow, [number, number]>(
				`SELECT ${COLUMNS} FROM items ORDER BY next_attempt_at, seq
				LIMIT ? OFFSET ?`,
			)
			.all(limit, offset)
			.map(itemOf);
	}

	async count(): Promise<number> {
		const row = this.#open
			.query<{ n: number }, []>('SELECT count(*) AS n FROM items')
			.get();
		return row?.n ?? 0;
	}

	async readMessage(id: string): Promise<Uint8Array | undefined> {
		const row = this.#open
			.query<{ content: Uint8Array }, [string]>(
				'SELECT content FROM messages WHERE item_id = ?',
			)
			.get(id);
		return row ? new Uint8Array(row.content) : undefined;
	}

	async claim(request: ClaimRequest): Promise<QueueItem | undefined> {
		checkClaim(request);
		const row = this.#open
			.query<ItemRow, Record<string, string | number>>(
				`UPDATE items SET lease_owner = $owner, lease_expires_at = $expires
				WHERE seq = (SELECT seq FROM items WHERE ${DUE}
					ORDER BY next_attempt_at, seq LIMIT 1)
				RETURNING ${COLUMNS}`,
			)
			.get({
				owner: request.owner,
				now: request.now,
				expires: request.now + request.leaseMs,
			});
		return row ? itemOf(row) : undefined;
	}

	async renew(id: string, owner: string, expiresAt: number): Promise<boolean> {
		checkOwner(owner);
		checkTime('expiresAt', expiresAt);
		const { changes } = this.#open
			.query(
				'UPDATE items SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?',
			)
			.run(expiresAt, id, owner);
		return changes > 0;
	}

	async complete(
		id: string,
		owner: string,
		result: AttemptResult,
	): Promise<QueueItem | undefined> {
		checkOwner(owner);
		checkResult(result);
		const db = this.#open;
		return db
			.transaction(() => {
				const row = this.#row(id, owner);
				if (!row) return undefined;
				const item = applyAttempt(itemOf(row), result);
				if (isDone(item)) {
					db.query('DELETE FROM items WHERE id = ?').run(id);
				} else {
					this.#write(item);
				}
				return item;
			})
			.immediate();
	}

	async reschedule(id: string, at: number, owner?: string): Promise<boolean> {
		checkTime('at', at);
		const db = this.#open;
		if (owner === undefined) {
			return (
				db
					.query('UPDATE items SET next_attempt_at = ? WHERE id = ?')
					.run(at, id).changes > 0
			);
		}
		checkOwner(owner);
		const { changes } = db
			.query(
				`UPDATE items SET next_attempt_at = ?, lease_owner = NULL,
				lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`,
			)
			.run(at, id, owner);
		return changes > 0;
	}

	async cancel(id: string): Promise<QueueItem | undefined> {
		const db = this.#open;
		return db
			.transaction(() => {
				const row = this.#row(id);
				if (!row) return undefined;
				db.query('DELETE FROM items WHERE id = ?').run(id);
				return itemOf(row);
			})
			.immediate();
	}
}
