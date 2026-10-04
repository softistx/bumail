import type { Writer } from './state';

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
export async function bury(w: Writer, tombstone: Tombstone): Promise<void> {
	const expunged = tombstone.kind === 'expunged' ? tombstone : undefined;
	const id = tombstone.kind === 'expunged' ? tombstone.messageId : tombstone.id;
	await w.rows(
		`INSERT INTO ${w.t.tombstones} (account_id, kind, modseq, id, created_modseq,
			mailbox_id, uid, joined_modseq)
		VALUES ($1, $2, $3::bigint, $4, $5::bigint, $6, $7::bigint, $8::bigint)`,
		[
			w.accountId,
			tombstone.kind,
			tombstone.modseq,
			id,
			tombstone.createdModseq,
			expunged?.mailboxId ?? null,
			expunged?.uid ?? null,
			expunged?.joinedModseq ?? null,
		],
	);
	if (w.maxTombstones !== Number.POSITIVE_INFINITY) await prune(w);
}

/**
 * Forgets the oldest tombstones past `maxTombstones`, as the memory store
 * forgets them: the account's floor rises to the last one forgotten.
 */
async function prune(w: Writer): Promise<void> {
	const t = w.t.tombstones;
	const counted = await w.one<{ count: number | string }>(
		`SELECT count(*) AS count FROM ${t} WHERE account_id = $1`,
		[w.accountId],
	);
	const excess = Number(counted?.count ?? 0) - w.maxTombstones;
	if (excess <= 0) return;
	await w.rows(
		`WITH last AS (
			SELECT seq, modseq FROM ${t} WHERE account_id = $1
			ORDER BY seq LIMIT 1 OFFSET $2::bigint
		), gone AS (
			DELETE FROM ${t} WHERE account_id = $1 AND seq <= (SELECT seq FROM last)
		)
		UPDATE ${w.t.accounts} SET floor = (SELECT modseq FROM last) WHERE id = $1`,
		[w.accountId, excess - 1],
	);
}
