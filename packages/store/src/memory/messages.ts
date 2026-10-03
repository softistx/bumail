import { readBlob } from '../contract/blob';
import { checkCount } from '../contract/checks';
import { flagsAfter, normalizeChange } from '../contract/flags';
import { checkNewMessage } from '../contract/message-checks';
import type {
	AccountListOptions,
	FlagChange,
	FlagResult,
	ListOptions,
	MailboxEntry,
	Message,
	MessagePage,
	MessagesResult,
	NewMessage,
} from '../contract/types';
import type { MailboxState, MemoryState, MessageState } from './state';

/** Joins a message to a mailbox, with the mailbox's next UID. */
export function join(
	mailbox: MailboxState,
	message: MessageState,
	modseq: number,
): void {
	message.mailboxes.set(mailbox.id, { uid: mailbox.uidNext++, modseq });
	mailbox.highestModseq = modseq;
}

export async function addMessage(
	state: MemoryState,
	accountId: string,
	mailboxId: string,
	input: NewMessage,
): Promise<Message> {
	state.mailbox(accountId, mailboxId);
	const { flags, receivedAt, threadId } = checkNewMessage(input);
	const blob = await readBlob(input.content);
	// Everything from here on runs in one go: the mailbox is looked up again.
	const mailbox = state.mailbox(accountId, mailboxId);
	state.checkUids(mailbox, 1);
	state.retain(mailbox.accountId, blob.blobId, blob.blob);
	const modseq = state.bump(mailbox.accountId);
	const id = crypto.randomUUID();
	const message: MessageState = {
		id,
		accountId: mailbox.accountId,
		threadId: threadId ?? id,
		blobId: blob.blobId,
		size: blob.size,
		flags,
		receivedAt,
		createdModseq: modseq,
		modseq,
		mailboxes: new Map(),
	};
	join(mailbox, message, modseq);
	state.messages.set(message.id, message);
	return state.messageView(message);
}

export function listMessages(
	state: MemoryState,
	accountId: string,
	mailboxId: string,
	options: ListOptions,
): MailboxEntry[] {
	state.mailbox(accountId, mailboxId);
	checkCount('changedSince', options.changedSince);
	checkCount('fromUid', options.fromUid);
	const fromUid = options.fromUid ?? 1;
	const since = options.changedSince ?? -1;
	const entries: { uid: number; state: MessageState }[] = [];
	for (const message of state.messages.values()) {
		const uid = message.mailboxes.get(mailboxId)?.uid;
		if (uid !== undefined && uid >= fromUid && message.modseq > since) {
			entries.push({ uid, state: message });
		}
	}
	return entries
		.sort((a, b) => a.uid - b.uid)
		.map(({ uid, state: message }) => ({
			uid,
			message: state.messageView(message),
		}));
}

export function listAccountMessages(
	state: MemoryState,
	accountId: string,
	options: AccountListOptions,
): MessagePage {
	state.account(accountId);
	checkCount('offset', options.offset);
	checkCount('limit', options.limit, 1);
	const all = [...state.messages.values()]
		.filter((message) => message.accountId === accountId)
		.sort((a, b) => a.createdModseq - b.createdModseq);
	const offset = options.offset ?? 0;
	const end = options.limit === undefined ? undefined : offset + options.limit;
	return {
		messages: all.slice(offset, end).map((m) => state.messageView(m)),
		total: all.length,
	};
}

export function setFlags(
	state: MemoryState,
	accountId: string,
	ids: readonly string[],
	change: FlagChange,
	unchangedSince: number | undefined,
): FlagResult {
	checkCount('unchangedSince', unchangedSince);
	const clean = normalizeChange(change);
	const { found, notFound } = state.messagesOf(accountId, ids);
	const result: Message[] = [];
	const modified: string[] = [];
	for (const message of found) {
		const flags = flagsAfter(message, clean, unchangedSince);
		if (flags === 'modified') {
			modified.push(message.id);
			continue;
		}
		if (flags) {
			message.flags = flags;
			state.touch(message);
		}
		result.push(state.messageView(message));
	}
	return { messages: result, notFound, modified };
}

export function copyMessages(
	state: MemoryState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): MessagesResult {
	const target = state.mailbox(accountId, mailboxId);
	const { found, notFound } = state.messagesOf(accountId, ids);
	state.checkUids(target, found.length);
	const messages = found.map((original) => {
		state.retain(original.accountId, original.blobId);
		const modseq = state.bump(target.accountId);
		const copy: MessageState = {
			...original,
			id: crypto.randomUUID(),
			flags: [...original.flags],
			createdModseq: modseq,
			modseq,
			mailboxes: new Map(),
		};
		join(target, copy, modseq);
		state.messages.set(copy.id, copy);
		return state.messageView(copy);
	});
	return { messages, notFound };
}

export function linkMessages(
	state: MemoryState,
	accountId: string,
	ids: readonly string[],
	mailboxId: string,
): MessagesResult {
	const target = state.mailbox(accountId, mailboxId);
	const { found, notFound } = state.messagesOf(accountId, ids);
	const joining = found.filter((message) => !message.mailboxes.has(mailboxId));
	state.checkUids(target, joining.length);
	for (const message of joining) join(target, message, state.touch(message));
	return {
		messages: found.map((message) => state.messageView(message)),
		notFound,
	};
}
