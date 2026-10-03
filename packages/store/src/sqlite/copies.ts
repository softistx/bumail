import type { MessagesResult } from '../contract/types';
import { checkRoom, join, touch } from './membership';
import { retain } from './ownership';
import {
	freshViews,
	insertMessage,
	isIn,
	type MessageRow,
	messagesOf,
} from './rows';
import type { SqliteState } from './state';

/**
 * IMAP COPY: new messages in the mailbox, sharing the content, flags, date
 * and thread of each original, each with a modseq of its own.
 */
export function copyMessages(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): MessagesResult {
	return state.atomic(() => {
		const target = state.mailbox(accountId, mailboxId);
		const { found, notFound } = messagesOf(state, accountId, ids);
		checkRoom(target, found.length);
		const copies = found.map((original) => {
			retain(state, accountId, original.blob_id);
			const modseq = state.bump(accountId);
			const copy: MessageRow = {
				...original,
				id: crypto.randomUUID(),
				created_modseq: modseq,
				modseq,
			};
			insertMessage(state, copy);
			join(state, mailboxId, copy.id, modseq);
			return copy.id;
		});
		return { messages: freshViews(state, accountId, copies), notFound };
	});
}

/** Puts messages in one more mailbox, keeping their ids; one already there is unchanged. */
export function linkMessages(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): MessagesResult {
	return state.atomic(() => {
		const target = state.mailbox(accountId, mailboxId);
		const { found, notFound } = messagesOf(state, accountId, ids);
		const joining = found.filter((row) => !isIn(state, row.id, mailboxId));
		checkRoom(target, joining.length);
		for (const row of joining) {
			join(state, mailboxId, row.id, touch(state, row));
		}
		return {
			messages: freshViews(
				state,
				accountId,
				found.map((row) => row.id),
			),
			notFound,
		};
	});
}
