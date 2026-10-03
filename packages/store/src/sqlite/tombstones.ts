import type { SqliteState } from './state';

/** What a store remembers is gone, for the changes. */
export type Tombstone =
	| {
			kind: 'expunged';
			modseq: number;
			messageId: string;
			mailboxId: string;
			uid: number;
			/** When the message came into the mailbox. */
			joinedModseq: number;
			/** When the message was added. */
			createdModseq: number;
	  }
	| {
			kind: 'message' | 'mailbox';
			modseq: number;
			id: string;
			createdModseq: number;
	  };

/** Remembers what is gone, for the changes; past `maxTombstones`, the oldest is forgotten. */
export function bury(
	state: SqliteState,
	accountId: string,
	tombstone: Tombstone,
): void {
	const expunged = tombstone.kind === 'expunged' ? tombstone : undefined;
	const id = tombstone.kind === 'expunged' ? tombstone.messageId : tombstone.id;
	state.db
		.query(
			`INSERT INTO tombstones (account_id, kind, modseq, id, created_modseq, mailbox_id, uid, joined_modseq)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			accountId,
			tombstone.kind,
			tombstone.modseq,
			id,
			tombstone.createdModseq,
			expunged?.mailboxId ?? null,
			expunged?.uid ?? null,
			expunged?.joinedModseq ?? null,
		);
	if (state.maxTombstones !== Number.POSITIVE_INFINITY) prune(state, accountId);
}

/**
 * Forgets the oldest tombstones past `maxTombstones`, as the memory store
 * forgets them: the account's floor rises to the last one forgotten.
 */
function prune(state: SqliteState, accountId: string): void {
	const { count } = state.db
		.query<{ count: number }, [string]>(
			'SELECT count(*) AS count FROM tombstones WHERE account_id = ?',
		)
		.get(accountId) as { count: number };
	const excess = count - state.maxTombstones;
	if (excess <= 0) return;
	const last = state.db
		.query<{ seq: number; modseq: number }, [string, number]>(
			`SELECT seq, modseq FROM tombstones WHERE account_id = ?
			ORDER BY seq LIMIT 1 OFFSET ?`,
		)
		.get(accountId, excess - 1) as { seq: number; modseq: number };
	state.db
		.query('DELETE FROM tombstones WHERE account_id = ? AND seq <= ?')
		.run(accountId, last.seq);
	state.db
		.query('UPDATE accounts SET floor = ? WHERE id = ?')
		.run(last.modseq, accountId);
}
