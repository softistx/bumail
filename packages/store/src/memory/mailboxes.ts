import { renameTarget } from '../contract/checks';
import { hasChildren } from '../contract/conflicts';
import {
	checkNewMailbox,
	checkSubscribed,
	type MailboxLookups,
	placeMailbox,
} from '../contract/mailbox-checks';
import { checkRequiredRole } from '../contract/mailbox-name';
import type {
	Expunged,
	Mailbox,
	MailboxRename,
	MailboxRole,
	NewMailbox,
} from '../contract/types';
import { StoreError } from '../errors';
import { expunge } from './membership';
import type { MailboxState, MemoryState } from './state';

/** The account's mailboxes, as the shared checks ask about them. */
function lookups(state: MemoryState, accountId: string): MailboxLookups {
	return {
		checkParent: (id) => state.mailbox(accountId, id),
		parentOf: (id) => state.mailboxes.get(id)?.parentId,
		isTaken: (name, parentId, self) => {
			for (const mailbox of state.mailboxes.values()) {
				if (
					mailbox.id !== self &&
					mailbox.accountId === accountId &&
					mailbox.parentId === parentId &&
					mailbox.name === name
				) {
					return true;
				}
			}
			return false;
		},
		hasRole: (role) => findMailbox(state, accountId, role) !== undefined,
	};
}

export function createMailbox(
	state: MemoryState,
	accountId: string,
	input: NewMailbox,
): Mailbox {
	state.account(accountId);
	const name = checkNewMailbox(lookups(state, accountId), input);
	const modseq = state.bump(accountId);
	const mailbox: MailboxState = {
		id: crypto.randomUUID(),
		accountId,
		name,
		...(input.parentId === undefined ? {} : { parentId: input.parentId }),
		...(input.role === undefined ? {} : { role: input.role }),
		isSubscribed: input.isSubscribed ?? true,
		uidValidity: state.nextUidValidity(),
		uidNext: 1,
		createdModseq: modseq,
		modseq,
		highestModseq: modseq,
	};
	state.mailboxes.set(mailbox.id, mailbox);
	return state.mailboxView(mailbox);
}

export function findMailbox(
	state: MemoryState,
	accountId: string,
	role: MailboxRole,
): MailboxState | undefined {
	state.account(accountId);
	checkRequiredRole(role);
	for (const mailbox of state.mailboxes.values()) {
		if (mailbox.accountId === accountId && mailbox.role === role)
			return mailbox;
	}
	return undefined;
}

export function renameMailbox(
	state: MemoryState,
	accountId: string,
	id: string,
	change: MailboxRename,
): Mailbox {
	const mailbox = state.mailbox(accountId, id);
	const { name, parentId } = renameTarget(mailbox, change);
	const clean = placeMailbox(
		lookups(state, mailbox.accountId),
		name,
		parentId,
		id,
	);
	mailbox.name = clean;
	if (parentId === undefined) delete mailbox.parentId;
	else mailbox.parentId = parentId;
	mailbox.modseq = state.bump(mailbox.accountId);
	return state.mailboxView(mailbox);
}

export function setSubscribed(
	state: MemoryState,
	accountId: string,
	id: string,
	subscribed: boolean,
): Mailbox {
	const mailbox = state.mailbox(accountId, id);
	checkSubscribed(subscribed);
	if (mailbox.isSubscribed !== subscribed) {
		mailbox.isSubscribed = subscribed;
		mailbox.modseq = state.bump(mailbox.accountId);
	}
	return state.mailboxView(mailbox);
}

export function deleteMailbox(
	state: MemoryState,
	accountId: string,
	id: string,
	removeMessages: boolean,
): Expunged[] {
	const mailbox = state.mailbox(accountId, id);
	for (const other of state.mailboxes.values()) {
		if (other.parentId === id) throw hasChildren();
	}
	const inside = [...state.messages.values()].filter((message) =>
		message.mailboxes.has(id),
	);
	if (inside.length > 0 && !removeMessages) {
		throw new StoreError(
			'INVALID',
			'Only an empty mailbox can be deleted without removeMessages',
		);
	}
	const expunged = inside.map((message) => expunge(state, message, id));
	const modseq = state.bump(mailbox.accountId);
	state.mailboxes.delete(id);
	state.bury(mailbox.accountId, {
		kind: 'mailbox',
		modseq,
		id,
		createdModseq: mailbox.createdModseq,
	});
	return expunged;
}
