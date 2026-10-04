import { readBlob } from '../contract/blob';
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
import { StoreError } from '../errors';
import { checkRoom, join } from './membership';
import { retain } from './ownership';
import { MESSAGE_COLUMNS, type MessageRow, messageOf, placesOf } from './rows';
import type { PgState, Writer } from './state';
import { isStorable } from './storable';

export async function insertMessage(w: Writer, row: MessageRow): Promise<void> {
	await w.rows(
		`INSERT INTO ${w.t.messages} (id, account_id, thread_id, blob_id, size, flags,
			received_at, created_modseq, modseq)
		VALUES ($1, $2, $3, $4, $5::bigint, $6::text::jsonb, $7::bigint, $8::bigint, $9::bigint)`,
		[
			row.id,
			row.account_id,
			row.thread_id,
			row.blob_id,
			row.size,
			JSON.stringify(row.flags),
			row.received_at,
			row.created_modseq,
			row.modseq,
		],
	);
}

/**
 * Adds a message. Its content is read to its end first, with no lock
 * held; then one transaction, under the account's lock, looks the mailbox
 * up again, keeps the bytes unless the account holds them already, and
 * takes the next modseq and UID.
 */
export async function addMessage(
	state: PgState,
	accountId: string,
	mailboxId: string,
	input: NewMessage,
): Promise<Message> {
	await state.read((db) => db.mailbox(accountId, mailboxId));
	const { flags, receivedAt, threadId } = checkNewMessage(input);
	const { blobId, size, blob } = await readBlob(input.content);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return state.write(accountId, async (w) => {
		const mailbox = await w.mailboxIn(accountId, mailboxId);
		checkRoom(mailbox, 1);
		await retain(w, blobId, { bytes, size });
		const modseq = w.bump();
		const id = crypto.randomUUID();
		await insertMessage(w, {
			id,
			account_id: accountId,
			thread_id: threadId ?? id,
			blob_id: blobId,
			size,
			flags,
			received_at: receivedAt,
			created_modseq: modseq,
			modseq,
		});
		await join(w, mailboxId, id, modseq);
		return (await w.freshViews(accountId, [id]))[0] as Message;
	});
}

export function getMessage(
	state: PgState,
	accountId: string,
	id: string,
): Promise<Message | undefined> {
	return state.read(async (db) => {
		await db.account(accountId);
		if (!isStorable(id)) return undefined;
		const [view] = await db.messageViews('m.id = $1 AND m.account_id = $2', [
			id,
			accountId,
		]);
		return view;
	});
}

/** The mailbox's messages from a UID up, changed after a modseq, in UID order: one statement. */
export function listMessages(
	state: PgState,
	accountId: string,
	mailboxId: string,
	options: ListOptions,
): Promise<MailboxEntry[]> {
	return state.read(async (db) => {
		await db.mailbox(accountId, mailboxId);
		checkCount('changedSince', options.changedSince);
		checkCount('fromUid', options.fromUid);
		const rows = await db.rows<
			Parameters<typeof messageOf>[0] & { entry_uid: number | string }
		>(
			`SELECT ms.uid AS entry_uid, ${MESSAGE_COLUMNS}, ${placesOf(db.t)}
			FROM ${db.t.memberships} ms JOIN ${db.t.messages} m ON m.id = ms.message_id
			WHERE ms.mailbox_id = $1 AND ms.uid >= $2::bigint AND m.modseq > $3::bigint
			ORDER BY ms.uid`,
			[mailboxId, options.fromUid ?? 1, options.changedSince ?? -1],
		);
		return rows.map((row) => ({
			uid: Number(row.entry_uid),
			message: messageOf(row),
		}));
	});
}

/** A page of the account's messages, oldest added first: `LIMIT` and `OFFSET` in the database. */
export function listAccountMessages(
	state: PgState,
	accountId: string,
	options: AccountListOptions,
): Promise<MessagePage> {
	return state.read(async (db) => {
		await db.account(accountId);
		checkCount('offset', options.offset);
		checkCount('limit', options.limit, 1);
		const counted = await db.one<{ total: number | string }>(
			`SELECT count(*) AS total FROM ${db.t.messages} WHERE account_id = $1`,
			[accountId],
		);
		const messages = await db.messageViews(
			'm.account_id = $1',
			[accountId, options.limit ?? null, options.offset ?? 0],
			'ORDER BY m.created_modseq LIMIT $2::bigint OFFSET $3::bigint',
		);
		return { messages, total: Number(counted?.total ?? 0) };
	});
}

/**
 * The content, when the account holds it: another account's blob is
 * `undefined`, even with the same bytes. One statement reads the account
 * and the bytes, which the Blob then holds: it stays valid after its
 * message is gone.
 */
export function readContent(
	state: PgState,
	accountId: string,
	blobId: string,
): Promise<Blob | undefined> {
	return state.direct(async (db) => {
		if (!isStorable(accountId)) throw noAccount(accountId);
		const [row] = await db.rows<{ content: Uint8Array | null }>(
			`SELECT c.content FROM ${db.t.accounts} a
			LEFT JOIN ${db.t.contents} c ON c.account_id = a.id AND c.blob_id = $2
			WHERE a.id = $1`,
			[accountId, isStorable(blobId) ? blobId : null],
		);
		if (!row) throw noAccount(accountId);
		return row.content === null
			? undefined
			: new Blob([row.content as Uint8Array<ArrayBuffer>]);
	});
}

const noAccount = (id: string) =>
	new StoreError('NOT_FOUND', `No account "${id}"`);
