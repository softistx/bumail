import type { Database } from 'bun:sqlite';
import { isMailboxRole } from '../contract/mailbox-name';
import type { Account, Mailbox } from '../contract/types';
import { StoreError } from '../errors';

export interface AccountRow {
	id: string;
	name: string;
	modseq: number;
	floor: number;
}

export interface MailboxRow {
	id: string;
	account_id: string;
	name: string;
	parent_id: string | null;
	role: string | null;
	is_subscribed: number;
	uid_validity: number;
	uid_next: number;
	created_modseq: number;
	modseq: number;
	highest_modseq: number;
}

/** The SQLite store's database, and the lookups and bookkeeping its operations share. */
export class SqliteState {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	/** Runs `fn` in one transaction: all of it, or none of it. */
	atomic<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	/** The account, or `NOT_FOUND`. */
	account(id: string): AccountRow {
		const row = this.db
			.query<AccountRow, [string]>(
				'SELECT id, name, modseq, floor FROM accounts WHERE id = ?',
			)
			.get(String(id));
		if (!row) throw new StoreError('NOT_FOUND', `No account "${id}"`);
		return row;
	}

	/** The account's mailbox, or `undefined`: another account's names nothing. */
	findMailboxRow(accountId: string, id: string): MailboxRow | undefined {
		return (
			this.db
				.query<MailboxRow, [string, string]>(
					'SELECT * FROM mailboxes WHERE id = ? AND account_id = ?',
				)
				.get(String(id), accountId) ?? undefined
		);
	}

	/**
	 * The account's mailbox with this id. An unknown account, and a mailbox
	 * of another account, are both `NOT_FOUND`: an id is no key to someone
	 * else's mail.
	 */
	mailbox(accountId: string, id: string): MailboxRow {
		this.account(accountId);
		const row = this.findMailboxRow(accountId, id);
		if (!row) throw new StoreError('NOT_FOUND', `No mailbox "${id}"`);
		return row;
	}

	/** The parent of a mailbox, for walking up the hierarchy. */
	parentOf(id: string): string | undefined {
		return (
			this.db
				.query<{ parent_id: string | null }, [string]>(
					'SELECT parent_id FROM mailboxes WHERE id = ?',
				)
				.get(id)?.parent_id ?? undefined
		);
	}

	/** The account's next modseq. */
	bump(accountId: string): number {
		const row = this.db
			.query<{ modseq: number }, [string]>(
				'UPDATE accounts SET modseq = modseq + 1 WHERE id = ? RETURNING modseq',
			)
			.get(accountId);
		if (!row) throw new StoreError('NOT_FOUND', `No account "${accountId}"`);
		return row.modseq;
	}

	/**
	 * The next UIDVALIDITY: never given twice by this database, and never
	 * below the time in seconds, as the memory store gives them.
	 */
	nextUidValidity(): number {
		const stored = this.db
			.query<{ value: number }, []>(
				"SELECT value FROM counters WHERE name = 'uid_validity'",
			)
			.get();
		const next = Math.max(stored?.value ?? 0, Math.floor(Date.now() / 1000));
		this.db
			.query(
				"INSERT INTO counters (name, value) VALUES ('uid_validity', ?1) ON CONFLICT (name) DO UPDATE SET value = ?1",
			)
			.run(next + 1);
		return next;
	}

	/** Remembers a mailbox destroyed at `modseq`, for the changes. */
	buryMailbox(
		accountId: string,
		id: string,
		modseq: number,
		createdModseq: number,
	): void {
		this.db
			.query(
				"INSERT INTO tombstones (account_id, kind, modseq, id, created_modseq) VALUES (?, 'mailbox', ?, ?, ?)",
			)
			.run(accountId, modseq, id, createdModseq);
	}

	/** A copy of the mailbox, with its counts. */
	mailboxView(row: MailboxRow): Mailbox {
		// No message is stored before the messages slice: every count is 0.
		return {
			id: row.id,
			accountId: row.account_id,
			name: row.name,
			...(row.parent_id === null ? {} : { parentId: row.parent_id }),
			...(isMailboxRole(row.role) ? { role: row.role } : {}),
			isSubscribed: row.is_subscribed === 1,
			uidValidity: row.uid_validity,
			uidNext: row.uid_next,
			highestModseq: row.highest_modseq,
			messages: 0,
			unseen: 0,
		};
	}

	accountView(row: { id: string; name: string }): Account {
		return { id: row.id, name: row.name };
	}
}
