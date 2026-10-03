import { checkUids } from '../contract/checks';
import type {
	Expunged,
	ExpungeResult,
	MessagesResult,
} from '../contract/types';
import { release } from './ownership';
import { freshViews, isIn, type MessageRow, messagesOf } from './rows';
import type { MailboxRow, SqliteState } from './state';
import { bury } from './tombstones';

/** Joins a message to a mailbox, with the mailbox's next UID. */
export function join(
	state: SqliteState,
	mailboxId: string,
	messageId: string,
	modseq: number,
): void {
	const { uid } = state.db
		.query<{ uid: number }, [number, string]>(
			`UPDATE mailboxes SET uid_next = uid_next + 1, highest_modseq = ?
			WHERE id = ? RETURNING uid_next - 1 AS uid`,
		)
		.get(modseq, mailboxId) as { uid: number };
	state.db
		.query(
			'INSERT INTO memberships (mailbox_id, uid, message_id, joined_modseq) VALUES (?, ?, ?, ?)',
		)
		.run(mailboxId, uid, messageId, modseq);
}

/** A message changed: a new modseq for it and for each mailbox it is, or was, in. */
export function touch(
	state: SqliteState,
	row: MessageRow,
	left?: string,
): number {
	const modseq = state.bump(row.account_id);
	row.modseq = modseq;
	state.db
		.query('UPDATE messages SET modseq = ? WHERE id = ?')
		.run(modseq, row.id);
	state.db
		.query(
			`UPDATE mailboxes SET highest_modseq = ?1
			WHERE id IN (SELECT mailbox_id FROM memberships WHERE message_id = ?2) OR id = ?3`,
		)
		.run(modseq, row.id, left ?? null);
	return modseq;
}

/** Takes a message out of one mailbox, remembering it; returns where it was. */
function leave(
	state: SqliteState,
	row: MessageRow,
	mailboxId: string,
): { uid: number; joinedModseq: number; modseq: number } {
	const { uid, joined_modseq: joinedModseq } = state.db
		.query<{ uid: number; joined_modseq: number }, [string, string]>(
			`DELETE FROM memberships WHERE message_id = ? AND mailbox_id = ?
			RETURNING uid, joined_modseq`,
		)
		.get(row.id, mailboxId) as { uid: number; joined_modseq: number };
	const modseq = touch(state, row, mailboxId);
	bury(state, row.account_id, {
		kind: 'expunged',
		messageId: row.id,
		mailboxId,
		uid,
		modseq,
		joinedModseq,
		createdModseq: row.created_modseq,
	});
	return { uid, joinedModseq, modseq };
}

/** Takes a message out of one mailbox; destroys it when it is in none left. */
export function expunge(
	state: SqliteState,
	row: MessageRow,
	mailboxId: string,
): Expunged {
	const { uid, modseq } = leave(state, row, mailboxId);
	const remaining = state.db
		.query('SELECT 1 FROM memberships WHERE message_id = ? LIMIT 1')
		.get(row.id);
	if (remaining === null) {
		state.db.query('DELETE FROM messages WHERE id = ?').run(row.id);
		release(state, row.account_id, row.blob_id);
		bury(state, row.account_id, {
			kind: 'message',
			modseq,
			id: row.id,
			createdModseq: row.created_modseq,
		});
	}
	return { messageId: row.id, mailboxId, uid, modseq };
}

/** The mailboxes a message is in, in the order it joined them. */
export function mailboxesOf(state: SqliteState, messageId: string): string[] {
	return state.db
		.query<{ mailbox_id: string }, [string]>(
			'SELECT mailbox_id FROM memberships WHERE message_id = ? ORDER BY joined_modseq',
		)
		.all(messageId)
		.map((row) => row.mailbox_id);
}

/** Refuses a mailbox with no room for `count` more UIDs. */
export function checkRoom(mailbox: MailboxRow, count: number): void {
	checkUids({ name: mailbox.name, uidNext: mailbox.uid_next }, count);
}

export function moveMessages(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
	from: string,
	to: string,
): MessagesResult {
	return state.atomic(() => {
		state.mailbox(accountId, from);
		const target = state.mailbox(accountId, to);
		const { found, notFound } = messagesOf(state, accountId, ids, from);
		const view = () => ({
			messages: freshViews(
				state,
				accountId,
				found.map((row) => row.id),
			),
			notFound,
		});
		if (from === to) return view();
		const joining = found.filter((row) => !isIn(state, row.id, to));
		checkRoom(target, joining.length);
		for (const row of found) {
			const staying = isIn(state, row.id, to);
			const { modseq } = leave(state, row, from);
			if (!staying) join(state, to, row.id, modseq);
		}
		return view();
	});
}

export function removeMessages(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): ExpungeResult {
	return state.atomic(() => {
		state.mailbox(accountId, mailboxId);
		const { found, notFound } = messagesOf(state, accountId, ids, mailboxId);
		return {
			expunged: found.map((row) => expunge(state, row, mailboxId)),
			notFound,
		};
	});
}

export function destroyMessages(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
): ExpungeResult {
	return state.atomic(() => {
		const { found, notFound } = messagesOf(state, accountId, ids);
		return {
			expunged: found.flatMap((row) =>
				mailboxesOf(state, row.id).map((mailboxId) =>
					expunge(state, row, mailboxId),
				),
			),
			notFound,
		};
	});
}
