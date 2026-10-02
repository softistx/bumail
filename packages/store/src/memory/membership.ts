import type { Expunged, Message } from '../contract/types';
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
		state.release(message.blobId);
		state.bury(message.accountId, {
			kind: 'message',
			modseq,
			id: message.id,
			createdModseq: message.createdModseq,
		});
	}
	return expunged;
}

function inMailbox(messages: MessageState[], mailboxId: string): void {
	for (const message of messages) {
		if (!message.mailboxes.has(mailboxId)) {
			throw new StoreError(
				'NOT_FOUND',
				`Message "${message.id}" is not in mailbox "${mailboxId}"`,
			);
		}
	}
}

export function moveMessages(
	state: MemoryState,
	ids: readonly string[],
	from: string,
	to: string,
): Message[] {
	const source = state.mailbox(from);
	const target = state.mailbox(to);
	if (source.accountId !== target.accountId) {
		throw new StoreError(
			'INVALID',
			'Messages only move between mailboxes of their own account',
		);
	}
	const messages = state.messagesOf(ids, target.accountId);
	inMailbox(messages, from);
	if (from === to) return messages.map((message) => state.messageView(message));
	const joining = messages.filter((message) => !message.mailboxes.has(to));
	state.checkUids(target, joining.length);
	for (const message of messages) {
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
	return messages.map((message) => state.messageView(message));
}

export function removeMessages(
	state: MemoryState,
	ids: readonly string[],
	mailboxId: string,
): Expunged[] {
	const mailbox = state.mailbox(mailboxId);
	const messages = state.messagesOf(ids, mailbox.accountId);
	inMailbox(messages, mailboxId);
	return messages.map((message) => expunge(state, message, mailboxId));
}

export function destroyMessages(
	state: MemoryState,
	ids: readonly string[],
): Expunged[] {
	const messages = state.messagesOf(ids);
	return messages.flatMap((message) =>
		[...message.mailboxes.keys()].map((mailboxId) =>
			expunge(state, message, mailboxId),
		),
	);
}
