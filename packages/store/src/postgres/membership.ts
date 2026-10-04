import { checkUids, partitionIds } from '../contract/checks';
import type {
	Expunged,
	ExpungeResult,
	MessagesResult,
} from '../contract/types';
import { release } from './ownership';
import type { MailboxRow, MessageRow } from './rows';
import type { PgState, Writer } from './state';
import { bury } from './tombstones';

/**
 * Joins a message to a mailbox, with the mailbox's next UID: taken and
 * counted in one statement, under the account's lock, so no two messages
 * ever share one and none is given again.
 */
export async function join(
	w: Writer,
	mailboxId: string,
	messageId: string,
	modseq: number,
): Promise<void> {
	await w.rows(
		`WITH box AS (
			UPDATE ${w.t.mailboxes} SET uid_next = uid_next + 1, highest_modseq = $3::bigint
			WHERE id = $1 RETURNING uid_next - 1 AS uid
		)
		INSERT INTO ${w.t.memberships} (mailbox_id, uid, message_id, joined_modseq)
		SELECT $1, uid, $2, $3::bigint FROM box`,
		[mailboxId, messageId, modseq],
	);
}

/** A message changed: a new modseq for it and for each mailbox it is, or was, in. */
export async function touch(
	w: Writer,
	row: MessageRow,
	left?: string,
): Promise<number> {
	const modseq = w.bump();
	row.modseq = modseq;
	await w.rows(
		`WITH message AS (
			UPDATE ${w.t.messages} SET modseq = $1::bigint WHERE id = $2
		)
		UPDATE ${w.t.mailboxes} SET highest_modseq = $1::bigint
		WHERE id IN (SELECT mailbox_id FROM ${w.t.memberships} WHERE message_id = $2)
			OR id = $3`,
		[modseq, row.id, left ?? null],
	);
	return modseq;
}

/** Takes a message out of one mailbox, remembering it; returns where it was. */
async function leave(
	w: Writer,
	row: MessageRow,
	mailboxId: string,
): Promise<{ uid: number; modseq: number }> {
	const [place] = await w.rows<{
		uid: number | string;
		joined_modseq: number | string;
	}>(
		`DELETE FROM ${w.t.memberships} WHERE message_id = $1 AND mailbox_id = $2
		RETURNING uid, joined_modseq`,
		[row.id, mailboxId],
	);
	const uid = Number(place?.uid);
	const modseq = await touch(w, row, mailboxId);
	await bury(w, {
		kind: 'expunged',
		messageId: row.id,
		mailboxId,
		uid,
		modseq,
		joinedModseq: Number(place?.joined_modseq),
		createdModseq: row.created_modseq,
	});
	return { uid, modseq };
}

/** Takes a message out of one mailbox; destroys it when it is in none left. */
export async function expunge(
	w: Writer,
	row: MessageRow,
	mailboxId: string,
): Promise<Expunged> {
	const { uid, modseq } = await leave(w, row, mailboxId);
	const destroyed = await w.rows(
		`DELETE FROM ${w.t.messages} WHERE id = $1 AND NOT EXISTS (
			SELECT 1 FROM ${w.t.memberships} WHERE message_id = $1
		) RETURNING id`,
		[row.id],
	);
	if (destroyed.length > 0) {
		await release(w, row.blob_id);
		await bury(w, {
			kind: 'message',
			modseq,
			id: row.id,
			createdModseq: row.created_modseq,
		});
	}
	return { messageId: row.id, mailboxId, uid, modseq };
}

/** The mailboxes a message is in, in the order it joined them. */
async function mailboxesOf(w: Writer, messageId: string): Promise<string[]> {
	const rows = await w.rows<{ mailbox_id: string }>(
		`SELECT mailbox_id FROM ${w.t.memberships} WHERE message_id = $1
		ORDER BY joined_modseq`,
		[messageId],
	);
	return rows.map((row) => row.mailbox_id);
}

/** Which of these messages are in the mailbox. */
export async function inMailbox(
	w: Writer,
	ids: readonly string[],
	mailboxId: string,
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const rows = await w.rows<{ message_id: string }>(
		`SELECT message_id FROM ${w.t.memberships} WHERE mailbox_id = $1
			AND message_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))`,
		[mailboxId, JSON.stringify(ids)],
	);
	return new Set(rows.map((row) => row.message_id));
}

/** Refuses a mailbox with no room for `count` more UIDs. */
export function checkRoom(mailbox: MailboxRow, count: number): void {
	checkUids({ name: mailbox.name, uidNext: mailbox.uid_next }, count);
}

/**
 * The account's messages for these ids, each once, and the ids that name
 * none: no such message, another account's, or one not in `mailboxId`.
 */
export async function messagesOf(
	w: Writer,
	ids: readonly string[],
	mailboxId?: string,
): Promise<{ found: MessageRow[]; notFound: string[] }> {
	const unique = partitionIds(ids, (id) => id).found;
	const rows = await w.messageRows(w.accountId, unique, mailboxId);
	return partitionIds(unique, (id) => rows.get(id));
}

export function moveMessages(
	state: PgState,
	accountId: string,
	ids: readonly string[],
	from: string,
	to: string,
): Promise<MessagesResult> {
	return state.write(accountId, async (w) => {
		await w.mailboxIn(accountId, from);
		const target = await w.mailboxIn(accountId, to);
		const { found, notFound } = await messagesOf(w, ids, from);
		const view = async () => ({
			messages: await w.freshViews(
				accountId,
				found.map((row) => row.id),
			),
			notFound,
		});
		if (from === to) return view();
		const staying = await inMailbox(
			w,
			found.map((row) => row.id),
			to,
		);
		checkRoom(target, found.length - staying.size);
		for (const row of found) {
			const { modseq } = await leave(w, row, from);
			if (!staying.has(row.id)) await join(w, to, row.id, modseq);
		}
		return view();
	});
}

export function removeMessages(
	state: PgState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): Promise<ExpungeResult> {
	return state.write(accountId, async (w) => {
		await w.mailboxIn(accountId, mailboxId);
		const { found, notFound } = await messagesOf(w, ids, mailboxId);
		const expunged: Expunged[] = [];
		for (const row of found) expunged.push(await expunge(w, row, mailboxId));
		return { expunged, notFound };
	});
}

export function destroyMessages(
	state: PgState,
	accountId: string,
	ids: readonly string[],
): Promise<ExpungeResult> {
	return state.write(accountId, async (w) => {
		const { found, notFound } = await messagesOf(w, ids);
		const expunged: Expunged[] = [];
		for (const row of found) {
			for (const mailboxId of await mailboxesOf(w, row.id)) {
				expunged.push(await expunge(w, row, mailboxId));
			}
		}
		return { expunged, notFound };
	});
}
