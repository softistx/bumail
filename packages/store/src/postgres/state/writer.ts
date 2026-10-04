import type { Tables } from '../connect';
import type { PostgresQueryable } from '../options';
import type { AccountRow } from '../rows';
import { Db } from './db';

/**
 * A write in one account, in one transaction that holds the account's
 * row locked from its first statement to its commit. Every write of an
 * account takes that lock first, so the writes of one account run one
 * after the other, on any instance, and commit in the order of their
 * modseqs: the account's counter, every mailbox's UIDs and the
 * tombstones are only ever changed under it. The modseq is counted here
 * and written back once, before the commit.
 */
export class Writer extends Db {
	readonly held: AccountRow;
	readonly maxTombstones: number;
	readonly #started: number;

	constructor(
		sql: PostgresQueryable,
		tables: Tables,
		account: AccountRow,
		maxTombstones: number,
	) {
		super(sql, tables);
		this.held = account;
		this.maxTombstones = maxTombstones;
		this.#started = account.modseq;
	}

	get accountId(): string {
		return this.held.id;
	}

	/** The account's next modseq. */
	bump(): number {
		this.held.modseq += 1;
		return this.held.modseq;
	}

	/** Writes the counter back, if it moved. */
	async finish(): Promise<void> {
		if (this.held.modseq === this.#started) return;
		await this.sql.unsafe(
			`UPDATE ${this.t.accounts} SET modseq = $2::bigint WHERE id = $1`,
			[this.accountId, this.held.modseq],
		);
	}

	/**
	 * The next UIDVALIDITY: never given twice by this database, and never
	 * below the time in seconds, as the memory store gives them. One row,
	 * locked until the commit, so two instances never give the same.
	 */
	async nextUidValidity(): Promise<number> {
		const row = await this.one<{ value: number | string }>(
			`INSERT INTO ${this.t.counters} (name, value) VALUES ('uid_validity', $1::bigint + 1)
			ON CONFLICT (name) DO UPDATE
				SET value = greatest(${this.t.counters}.value, $1::bigint) + 1
			RETURNING value - 1 AS value`,
			[Math.floor(Date.now() / 1000)],
		);
		return Number(row?.value);
	}
}
