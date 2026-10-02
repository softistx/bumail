import type {
	Expunged,
	ExpungeResult,
	MessagesResult,
} from '../contract/types';
import { StoreError } from '../errors';
import { join } from './messages';
import type { MemoryState, MessageState } from './state';

/** Takes a message out of one mailbox; destroys it when it is in none left. */
export function expunge(
	state: MemoryState,
	message: MessageState,
	mailboxId: string,
): Expunged {
	const uid = (message.mailboxes.get(mailboxId) as { uid: number }).uid;
	message.mailboxes.delete(mailboxId);
	const modseq = state.touch(message, mailboxId);
	const expunged = { messageId: message.id, mailboxId, uid, modseq };
	state.bury(message.accountId, { kind: 'expunged', ...expunged });
	if (message.mailboxes.size === 0) {
		state.messages.delete(message.id);
		state.release(message.accountId, message.blobId);
		state.bury(message.accountId, {
			kind: 'message',
			modseq,
			id: message.id,
			createdModseq: message.createdModseq,
		});
	}
	return expunged;
}

export function moveMessages(
	state: MemoryState,
	ids: readonly string[],
	from: string,
	to: string,
): MessagesResult {
	const source = state.mailbox(from);
	const target = state.mailbox(to);
	if (source.accountId !== target.accountId) {
		throw new StoreError(
			'INVALID',
			'Messages only move between mailboxes of their own account',
		);
	}
	const { found, notFound } = state.messagesOf(ids, target.accountId, (m) =>
		m.mailboxes.has(from),
	);
	const view = () => ({
		messages: found.map((message) => state.messageView(message)),
		notFound,
	});
	if (from === to) return view();
	const joining = found.filter((message) => !message.mailboxes.has(to));
	state.checkUids(target, joining.length);
	for (const message of found) {
		const uid = (message.mailboxes.get(from) as { uid: number }).uid;
		message.mailboxes.delete(from);
		const modseq = state.touch(message, from);
		if (!message.mailboxes.has(to)) join(target, message, modseq);
		state.bury(message.accountId, {
			kind: 'expunged',
			messageId: message.id,
			mailboxId: from,
			uid,
			modseq,
		});
	}
	return view();
}

export function removeMessages(
	state: MemoryState,
	ids: readonly string[],
	mailboxId: string,
): ExpungeResult {
	const mailbox = state.mailbox(mailboxId);
	const { found, notFound } = state.messagesOf(ids, mailbox.accountId, (m) =>
		m.mailboxes.has(mailboxId),
	);
	return {
		expunged: found.map((message) => expunge(state, message, mailboxId)),
		notFound,
	};
}

export function destroyMessages(
	state: MemoryState,
	ids: readonly string[],
): ExpungeResult {
	const { found, notFound } = state.messagesOf(ids);
	return {
		expunged: found.flatMap((message) =>
			[...message.mailboxes.keys()].map((mailboxId) =>
				expunge(state, message, mailboxId),
			),
		),
		notFound,
	};
}
