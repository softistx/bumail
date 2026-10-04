import type { Tables } from '../connect';
import type { PostgresClient } from '../options';
import { accountOf, rowsOf } from '../rows';
import { isStorable } from '../storable';
import { Db, noAccount } from './db';
import { Writer } from './writer';

export { Db } from './db';
export { Writer } from './writer';

/** The PostgreSQL store's client and tables, and how its operations reach them. */
export class PgState {
	readonly client: PostgresClient;
	readonly t: Tables;
	readonly maxTombstones: number;
	readonly #ready: () => Promise<void>;

	constructor(
		client: PostgresClient,
		tables: Tables,
		maxTombstones: number,
		ready: () => Promise<void>,
	) {
		this.client = client;
		this.t = tables;
		this.maxTombstones = maxTombstones;
		this.#ready = ready;
	}

	/** One statement or several that need no common snapshot, on the pool. */
	async direct<T>(fn: (db: Db) => Promise<T>): Promise<T> {
		await this.#ready();
		return fn(new Db(this.client, this.t));
	}

	/**
	 * A read of several statements, in one `REPEATABLE READ` transaction:
	 * they all see the database as one instant left it, so a count, a
	 * modseq and the rows it covers always agree.
	 */
	async read<T>(fn: (db: Db) => Promise<T>): Promise<T> {
		await this.#ready();
		return (await this.client.begin(async (sql) => {
			await sql.unsafe(
				'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
			);
			return fn(new Db(sql, this.t));
		})) as T;
	}

	/** A write in the account: see `Writer`. An unknown account is `NOT_FOUND`. */
	async write<T>(accountId: string, fn: (w: Writer) => Promise<T>): Promise<T> {
		await this.#ready();
		if (!isStorable(accountId)) throw noAccount(accountId);
		return (await this.client.begin(async (sql) => {
			// READ COMMITTED whatever the client's default: under a stricter
			// level, waiting on the lock would end in a serialization failure.
			await sql.unsafe(
				'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE',
			);
			const raw = await rowsOf<Parameters<typeof accountOf>[0]>(
				sql.unsafe(
					`SELECT id, name, modseq, floor FROM ${this.t.accounts}
					WHERE id = $1 FOR UPDATE`,
					[accountId],
				),
			);
			const [found] = raw;
			if (!found) throw noAccount(accountId);
			const w = new Writer(sql, this.t, accountOf(found), this.maxTombstones);
			const result = await fn(w);
			await w.finish();
			return result;
		})) as T;
	}
}
