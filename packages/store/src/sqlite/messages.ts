import { checkCount } from '../contract/checks';
import { checkNewMessage } from '../contract/message-checks';
import type {
	AccountListOptions,
	ListOptions,
	MailboxEntry,
	Message,
	MessagePage,
	NewMessage,
} from '../contract/types';
import { checkRoom, join } from './membership';
import { holds, retain } from './ownership';
import {
	insertMessage,
	type MessageRow,
	messageRow,
	messageViews,
} from './rows';
import type { SqliteState } from './state';

/**
 * Adds a message. Its content is written to its blob and flushed first;
 * only then does the row that names it commit, in one transaction that
 * looks the mailbox up again. A crash in between leaves a blob nothing
 * names, never a row naming no blob.
 */
export async function addMessage(
	state: SqliteState,
	accountId: string,
	mailboxId: string,
	input: NewMessage,
): Promise<Message> {
	state.mailbox(accountId, mailboxId);
	const { flags, receivedAt, threadId } = checkNewMessage(input);
	const { blobId, size } = await state.blobs.write(input.content);
	let message: Message;
	try {
		message = state.atomic(() => {
			const mailbox = state.mailbox(accountId, mailboxId);
			checkRoom(mailbox, 1);
			retain(state, accountId, blobId);
			const modseq = state.bump(accountId);
			const id = crypto.randomUUID();
			const row: MessageRow = {
				id,
				account_id: accountId,
				thread_id: threadId ?? id,
				blob_id: blobId,
				size,
				flags: JSON.stringify(flags),
				received_at: receivedAt,
				created_modseq: modseq,
				modseq,
			};
			insertMessage(state, row);
			join(state, mailboxId, id, modseq);
			return messageViews(state, [row])[0] as Message;
		});
	} catch (error) {
		state.blobs.settle(blobId);
		await state.blobs.collect([blobId]);
		throw error;
	}
	state.blobs.settle(blobId);
	return message;
}

export function getMessage(
	state: SqliteState,
	accountId: string,
	id: string,
): Message | undefined {
	state.account(accountId);
	const row = messageRow(state, accountId, id);
	return row && messageViews(state, [row])[0];
}

export function listMessages(
	state: SqliteState,
	accountId: string,
	mailboxId: string,
	options: ListOptions,
): MailboxEntry[] {
	state.mailbox(accountId, mailboxId);
	checkCount('changedSince', options.changedSince);
	checkCount('fromUid', options.fromUid);
	const rows = state.db
		.query<MessageRow & { uid: number }, [string, number, number]>(
			`SELECT ms.uid, m.* FROM memberships ms JOIN messages m ON m.id = ms.message_id
			WHERE ms.mailbox_id = ? AND ms.uid >= ? AND m.modseq > ?
			ORDER BY ms.uid`,
		)
		.all(mailboxId, options.fromUid ?? 1, options.changedSince ?? -1);
	const messages = messageViews(state, rows);
	return rows.map((row, i) => ({
		uid: row.uid,
		message: messages[i] as Message,
	}));
}

export function listAccountMessages(
	state: SqliteState,
	accountId: string,
	options: AccountListOptions,
): MessagePage {
	state.account(accountId);
	checkCount('offset', options.offset);
	checkCount('limit', options.limit, 1);
	const { total } = state.db
		.query<{ total: number }, [string]>(
			'SELECT count(*) AS total FROM messages WHERE account_id = ?',
		)
		.get(accountId) as { total: number };
	const rows = state.db
		.query<MessageRow, [string, number, number]>(
			`SELECT * FROM messages WHERE account_id = ?
			ORDER BY created_modseq LIMIT ? OFFSET ?`,
		)
		.all(accountId, options.limit ?? -1, options.offset ?? 0);
	return { messages: messageViews(state, rows), total };
}

/**
 * The content, as a lazy file, when the account holds it: another
 * account's blob is `undefined`, even with the same bytes.
 */
export async function readContent(
	state: SqliteState,
	accountId: string,
	blobId: string,
): Promise<Blob | undefined> {
	state.account(accountId);
	if (!holds(state, accountId, blobId)) return undefined;
	return state.blobs.files.file(blobId);
}
