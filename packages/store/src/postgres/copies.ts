import type { MessagesResult } from '../contract/types';
import { checkRoom, inMailbox, join, messagesOf, touch } from './membership';
import { insertMessage } from './messages';
import { retain } from './ownership';
import type { PgState } from './state';

/**
 * IMAP COPY: new messages in the mailbox, sharing the content, flags, date
 * and thread of each original, each with a modseq of its own.
 */
export function copyMessages(
	state: PgState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): Promise<MessagesResult> {
	return state.write(accountId, async (w) => {
		const target = await w.mailboxIn(accountId, mailboxId);
		const { found, notFound } = await messagesOf(w, ids);
		checkRoom(target, found.length);
		const copies: string[] = [];
		for (const original of found) {
			await retain(w, original.blob_id);
			const modseq = w.bump();
			const id = crypto.randomUUID();
			await insertMessage(w, {
				...original,
				id,
				created_modseq: modseq,
				modseq,
			});
			await join(w, mailboxId, id, modseq);
			copies.push(id);
		}
		return { messages: await w.freshViews(accountId, copies), notFound };
	});
}

/** Puts messages in one more mailbox, keeping their ids; one already there is unchanged. */
export function linkMessages(
	state: PgState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): Promise<MessagesResult> {
	return state.write(accountId, async (w) => {
		const target = await w.mailboxIn(accountId, mailboxId);
		const { found, notFound } = await messagesOf(w, ids);
		const there = await inMailbox(
			w,
			found.map((row) => row.id),
			mailboxId,
		);
		const joining = found.filter((row) => !there.has(row.id));
		checkRoom(target, joining.length);
		for (const row of joining) {
			await join(w, mailboxId, row.id, await touch(w, row));
		}
		return {
			messages: await w.freshViews(
				accountId,
				found.map((row) => row.id),
			),
			notFound,
		};
	});
}
