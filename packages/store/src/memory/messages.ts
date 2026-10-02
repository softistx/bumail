import { readBlob } from '../contract/blob';
import {
	applyFlagChange,
	normalizeChange,
	normalizeFlags,
	sameFlags,
} from '../contract/flags';
import type {
	FlagChange,
	FlagResult,
	ListOptions,
	MailboxEntry,
	Message,
	NewMessage,
} from '../contract/types';
import { StoreError } from '../errors';
import type { MailboxState, MemoryState, MessageState } from './state';

function checkModseq(name: string, value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new StoreError(
			'INVALID',
			`${name} must be an integer of at least 0, not ${value}`,
		);
	}
}

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
	mailboxId: string,
	input: NewMessage,
): Promise<Message> {
	state.mailbox(mailboxId);
	const flags = normalizeFlags(input.flags ?? []);
	const receivedAt = input.receivedAt?.getTime() ?? Date.now();
	if (!Number.isFinite(receivedAt)) {
		throw new StoreError('INVALID', 'receivedAt is not a valid date');
	}
	const blob = await readBlob(input.content);
	// Everything from here on runs in one go: the mailbox is looked up again.
	const mailbox = state.mailbox(mailboxId);
	state.checkUids(mailbox, 1);
	const bytes = new Uint8Array(blob.size);
	let offset = 0;
	for (const chunk of blob.chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	state.retain(blob.blobId, bytes);
	const modseq = state.bump(mailbox.accountId);
	const message: MessageState = {
		id: crypto.randomUUID(),
		accountId: mailbox.accountId,
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
	mailboxId: string,
	options: ListOptions,
): MailboxEntry[] {
	state.mailbox(mailboxId);
	checkModseq('changedSince', options.changedSince);
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

export function setFlags(
	state: MemoryState,
	ids: readonly string[],
	change: FlagChange,
	unchangedSince: number | undefined,
): FlagResult {
	checkModseq('unchangedSince', unchangedSince);
	const clean = normalizeChange(change);
	const messages = state.messagesOf(ids);
	const result: Message[] = [];
	const modified: string[] = [];
	for (const message of messages) {
		if (unchangedSince !== undefined && message.modseq > unchangedSince) {
			modified.push(message.id);
			continue;
		}
		const flags = applyFlagChange(message.flags, clean);
		if (!sameFlags(flags, message.flags)) {
			message.flags = flags;
			state.touch(message);
		}
		result.push(state.messageView(message));
	}
	return { messages: result, modified };
}

export function copyMessages(
	state: MemoryState,
	ids: readonly string[],
	mailboxId: string,
): Message[] {
	const target = state.mailbox(mailboxId);
	const messages = state.messagesOf(ids, target.accountId);
	state.checkUids(target, messages.length);
	return messages.map((original) => {
		state.retain(original.blobId);
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
}

export function linkMessages(
	state: MemoryState,
	ids: readonly string[],
	mailboxId: string,
): Message[] {
	const target = state.mailbox(mailboxId);
	const messages = state.messagesOf(ids, target.accountId);
	const joining = messages.filter(
		(message) => !message.mailboxes.has(mailboxId),
	);
	state.checkUids(target, joining.length);
	for (const message of joining) join(target, message, state.touch(message));
	return messages.map((message) => state.messageView(message));
}
