import { partitionIds } from '../contract/checks';
import type { Membership, Message } from '../contract/types';
import type { SqliteState } from './state';

export interface MessageRow {
	id: string;
	account_id: string;
	thread_id: string;
	blob_id: string;
	size: number;
	/** A JSON array of the flags, sorted. */
	flags: string;
	received_at: number;
	created_modseq: number;
	modseq: number;
}

interface PlaceRow {
	message_id: string;
	mailbox_id: string;
	uid: number;
	joined_modseq: number;
}

export function insertMessage(state: SqliteState, row: MessageRow): void {
	state.db
		.query(
			`INSERT INTO messages (id, account_id, thread_id, blob_id, size, flags,
				received_at, created_modseq, modseq)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.account_id,
			row.thread_id,
			row.blob_id,
			row.size,
			row.flags,
			row.received_at,
			row.created_modseq,
			row.modseq,
		);
}

/** The account's message with this id, or `undefined`: another account's names nothing. */
export function messageRow(
	state: SqliteState,
	accountId: string,
	id: string,
): MessageRow | undefined {
	return (
		state.db
			.query<MessageRow, [string, string]>(
				'SELECT * FROM messages WHERE id = ? AND account_id = ?',
			)
			.get(String(id), accountId) ?? undefined
	);
}

/** Whether the message is in the mailbox. */
export function isIn(
	state: SqliteState,
	messageId: string,
	mailboxId: string,
): boolean {
	return (
		state.db
			.query(
				'SELECT 1 FROM memberships WHERE message_id = ? AND mailbox_id = ?',
			)
			.get(messageId, mailboxId) !== null
	);
}

/**
 * The account's messages for these ids, each once, and the ids that name
 * none: no such message, another account's, or one not in `mailboxId`.
 */
export function messagesOf(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
	mailboxId?: string,
): { found: MessageRow[]; notFound: string[] } {
	state.account(accountId);
	return partitionIds(ids, (id) => {
		const row = messageRow(state, accountId, id);
		return row && (mailboxId === undefined || isIn(state, id, mailboxId))
			? row
			: undefined;
	});
}

/** Where the messages are, in the order each joined: as the memory store keeps them. */
function placesOf(
	state: SqliteState,
	ids: readonly string[],
): Map<string, Membership[]> {
	const places = new Map<string, Membership[]>(ids.map((id) => [id, []]));
	const rows = state.db
		.query<PlaceRow, [string]>(
			`SELECT message_id, mailbox_id, uid, joined_modseq FROM memberships
			WHERE message_id IN (SELECT value FROM json_each(?))
			ORDER BY joined_modseq`,
		)
		.all(JSON.stringify(ids));
	for (const row of rows) {
		places.get(row.message_id)?.push({
			mailboxId: row.mailbox_id,
			uid: row.uid,
			modseq: row.joined_modseq,
		});
	}
	return places;
}

/** Copies of the messages, with their mailboxes: the caller's to change. */
export function messageViews(
	state: SqliteState,
	rows: readonly MessageRow[],
): Message[] {
	const places = placesOf(
		state,
		rows.map((row) => row.id),
	);
	return rows.map((row) => ({
		id: row.id,
		accountId: row.account_id,
		threadId: row.thread_id,
		blobId: row.blob_id,
		size: row.size,
		flags: JSON.parse(row.flags) as string[],
		receivedAt: new Date(row.received_at),
		createdModseq: row.created_modseq,
		modseq: row.modseq,
		mailboxes: places.get(row.id) ?? [],
	}));
}

/** The messages as they are now, read again: what an operation answers. */
export function freshViews(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
): Message[] {
	const rows = ids.flatMap((id) => messageRow(state, accountId, id) ?? []);
	return messageViews(state, rows);
}
