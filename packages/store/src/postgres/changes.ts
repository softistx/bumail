import { mailboxChangesOf, messageChangesOf } from '../contract/changes';
import { checkSince, type Item } from '../contract/paging';
import type {
	ChangesOptions,
	MailboxChanges,
	MessageChanges,
	MessageChangesOptions,
} from '../contract/types';
import type { Tables } from './connect';
import type { AccountRow } from './rows';
import type { Db, PgState } from './state';

// The changes are worked out in the database: each statement below yields
// the items the shared helpers of `contract/changes.ts` would build from
// the rows (`accountMessageItems`, `mailboxMessageItems`, `expungedItems`,
// `mailboxItems`), each with the modseq it sorts by as `key`. Only a page
// of them then leaves the database, and `page` cuts it as for every store.
// $1 is the account, $2 `since`, $3 where the page is cut, $4 the mailbox.

/** Every message of the account changed or destroyed after `since`, and every departure. */
const accountItems = (t: Tables) => `
	SELECT id,
		CASE WHEN created_modseq > $2::bigint THEN created_modseq ELSE modseq END AS key,
		CASE WHEN created_modseq > $2::bigint THEN 'created' ELSE 'updated' END AS kind,
		NULL::text AS mailbox_id, NULL::bigint AS uid, 0::bigint AS tie
	FROM ${t.messages} WHERE account_id = $1 AND modseq > $2::bigint
	UNION ALL
	SELECT id, modseq, 'destroyed', NULL, NULL, 0 FROM ${t.tombstones}
	WHERE account_id = $1 AND kind = 'message' AND modseq > $2::bigint
		AND created_modseq <= $2::bigint
	UNION ALL
	SELECT id, modseq, 'expunged', mailbox_id, uid, 0 FROM ${t.tombstones}
	WHERE account_id = $1 AND kind = 'expunged' AND modseq > $2::bigint
		AND $2::bigint > 0`;

/**
 * One mailbox's messages as if it were the account: one that came in
 * after `since` is created, by its first coming in; one that was in at
 * `since` and is not now is destroyed, by its leaving; one that left and
 * came back is updated. Its departures are its expunged.
 */
const mailboxItems = (t: Tables) => `
	WITH gone AS (
		SELECT id, modseq, uid, joined_modseq FROM ${t.tombstones}
		WHERE account_id = $1 AND kind = 'expunged' AND mailbox_id = $4
			AND modseq > $2::bigint
	), was_in AS (
		SELECT id, max(modseq) AS modseq FROM gone
		WHERE joined_modseq <= $2::bigint GROUP BY id
	), came AS (
		SELECT id, min(joined_modseq) AS joined FROM gone
		WHERE joined_modseq > $2::bigint GROUP BY id
	), members AS (
		SELECT m.id, m.modseq, coalesce(came.joined, ms.joined_modseq) AS first_in,
			was_in.id IS NOT NULL AS stayed
		FROM ${t.memberships} ms
		JOIN ${t.messages} m ON m.id = ms.message_id
		LEFT JOIN came ON came.id = m.id
		LEFT JOIN was_in ON was_in.id = m.id
		WHERE ms.mailbox_id = $4 AND m.modseq > $2::bigint
	)
	SELECT id,
		CASE WHEN first_in > $2::bigint AND NOT stayed THEN first_in ELSE modseq END AS key,
		CASE WHEN first_in > $2::bigint AND NOT stayed THEN 'created' ELSE 'updated' END AS kind,
		NULL::text AS mailbox_id, NULL::bigint AS uid, 0::bigint AS tie
	FROM members
	UNION ALL
	SELECT id, modseq, 'destroyed', NULL, NULL, 0 FROM was_in
	WHERE NOT EXISTS (SELECT 1 FROM members WHERE members.id = was_in.id)
	UNION ALL
	SELECT id, modseq, 'expunged', $4::text, uid, 0 FROM gone WHERE $2::bigint > 0`;

/** The account's mailboxes changed after `since` — themselves or their messages — and those deleted. */
const mailboxChangeItems = (t: Tables) => `
	SELECT id,
		CASE WHEN created_modseq > $2::bigint THEN created_modseq
			ELSE greatest(modseq, highest_modseq) END AS key,
		CASE WHEN created_modseq > $2::bigint THEN 'created' ELSE 'updated' END AS kind,
		NULL::text AS mailbox_id, NULL::bigint AS uid, created_modseq AS tie
	FROM ${t.mailboxes}
	WHERE account_id = $1 AND greatest(modseq, highest_modseq) > $2::bigint
	UNION ALL
	SELECT id, modseq, 'destroyed', NULL, NULL, created_modseq FROM ${t.tombstones}
	WHERE account_id = $1 AND kind = 'mailbox' AND modseq > $2::bigint
		AND created_modseq <= $2::bigint`;

interface ItemRow {
	id: string;
	key: number | string;
	kind: Item['kind'];
	mailbox_id: string | null;
	uid: number | string | null;
}

/**
 * The items of `items` (a statement over $1, $2 and what follows $3), in
 * the order they sort, cut in the database: with a `limit`, only those up
 * to the key of the item past it, or up to the floor if that is later —
 * all `page` needs to cut where it would cut them all — and whether any
 * are left.
 */
async function itemsUpTo(
	db: Db,
	items: string,
	account: AccountRow,
	since: number,
	limit: number | undefined,
	extra: unknown[] = [],
): Promise<{ items: Item[]; more: boolean }> {
	const of = `WITH items AS (${items})`;
	const values = (third: number | null) => [account.id, since, third, ...extra];
	let bound: number | null = null;
	let more = false;
	if (limit !== undefined) {
		const past = await db.one<{ key: number | string }>(
			`${of} SELECT key FROM items ORDER BY key OFFSET $3::bigint LIMIT 1`,
			values(limit),
		);
		if (past !== undefined) {
			bound = Math.max(Number(past.key), account.floor);
			const left = await db.one<{ more: boolean }>(
				`${of} SELECT EXISTS (SELECT 1 FROM items WHERE key > $3::bigint) AS more`,
				values(bound),
			);
			more = left?.more === true;
		}
	}
	const rows = await db.rows<ItemRow>(
		`${of} SELECT id, key, kind, mailbox_id, uid FROM items
		WHERE $3::bigint IS NULL OR key <= $3::bigint ORDER BY key, tie`,
		values(bound),
	);
	return {
		items: rows.map((row): Item => {
			const modseq = Number(row.key);
			if (row.kind !== 'expunged')
				return { id: row.id, modseq, kind: row.kind };
			return {
				id: row.id,
				modseq,
				kind: 'expunged',
				expunged: {
					messageId: row.id,
					mailboxId: row.mailbox_id as string,
					uid: Number(row.uid),
					modseq,
				},
			};
		}),
		more,
	};
}

/** What changed among the account's messages since a modseq. */
export function messageChanges(
	state: PgState,
	accountId: string,
	since: number,
	options: MessageChangesOptions,
): Promise<MessageChanges> {
	return state.read(async (db) => {
		const account = await db.account(accountId);
		const { mailboxId } = options;
		if (mailboxId !== undefined) await db.mailboxIn(accountId, mailboxId);
		checkSince(account, since, options);
		const { items, more } = await itemsUpTo(
			db,
			mailboxId === undefined ? accountItems(db.t) : mailboxItems(db.t),
			account,
			since,
			options.limit,
			mailboxId === undefined ? [] : [mailboxId],
		);
		return messageChangesOf(account, items, options.limit, more);
	});
}

/** What changed among the account's mailboxes since a modseq. */
export function mailboxChanges(
	state: PgState,
	accountId: string,
	since: number,
	options: ChangesOptions,
): Promise<MailboxChanges> {
	return state.read(async (db) => {
		const account = await db.account(accountId);
		checkSince(account, since, options);
		const { items, more } = await itemsUpTo(
			db,
			mailboxChangeItems(db.t),
			account,
			since,
			options.limit,
		);
		return mailboxChangesOf(account, items, options.limit, more);
	});
}
