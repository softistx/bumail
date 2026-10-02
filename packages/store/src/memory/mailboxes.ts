import {
	checkNoCycle,
	checkRole,
	normalizeMailboxName,
} from '../contract/mailbox-name';
import type { Expunged, Mailbox, NewMailbox } from '../contract/types';
import { StoreError } from '../errors';
import { expunge } from './membership';
import type { MailboxState, MemoryState } from './state';

/** Checks a name and a parent for a mailbox, `self` when it is a rename. */
function placeOf(
	state: MemoryState,
	accountId: string,
	name: string,
	parentId: string | undefined,
	self?: string,
): string {
	const clean = normalizeMailboxName(name, parentId);
	if (parentId !== undefined) {
		if (state.mailbox(parentId).accountId !== accountId) {
			throw new StoreError(
				'INVALID',
				'A parent mailbox must be in the same account',
			);
		}
		if (self !== undefined) {
			checkNoCycle(self, parentId, (id) => state.mailboxes.get(id)?.parentId);
		}
	}
	for (const mailbox of state.mailboxes.values()) {
		if (
			mailbox.id !== self &&
			mailbox.accountId === accountId &&
			mailbox.parentId === parentId &&
			mailbox.name === clean
		) {
			throw new StoreError(
				'ALREADY_EXISTS',
				`A mailbox "${clean}" already exists there`,
			);
		}
	}
	return clean;
}

export function createMailbox(
	state: MemoryState,
	accountId: string,
	input: NewMailbox,
): Mailbox {
	state.account(accountId);
	if (typeof input !== 'object' || input === null) {
		throw new StoreError('INVALID', 'A new mailbox is an object');
	}
	const name = placeOf(state, accountId, input.name, input.parentId);
	checkRole(input.role);
	if (
		input.isSubscribed !== undefined &&
		typeof input.isSubscribed !== 'boolean'
	) {
		throw new StoreError('INVALID', 'isSubscribed is true or false');
	}
	if (input.role !== undefined && findMailbox(state, accountId, input.role)) {
		throw new StoreError(
			'ALREADY_EXISTS',
			`The account already has a mailbox with the role ${input.role}`,
		);
	}
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
	role: string,
): MailboxState | undefined {
	state.account(accountId);
	for (const mailbox of state.mailboxes.values()) {
		if (mailbox.accountId === accountId && mailbox.role === role)
			return mailbox;
	}
	return undefined;
}

export function renameMailbox(
	state: MemoryState,
	id: string,
	name: string,
	parentId: string | undefined,
): Mailbox {
	const mailbox = state.mailbox(id);
	const clean = placeOf(state, mailbox.accountId, name, parentId, id);
	mailbox.name = clean;
	if (parentId === undefined) delete mailbox.parentId;
	else mailbox.parentId = parentId;
	mailbox.modseq = state.bump(mailbox.accountId);
	return state.mailboxView(mailbox);
}

export function setSubscribed(
	state: MemoryState,
	id: string,
	subscribed: boolean,
): Mailbox {
	const mailbox = state.mailbox(id);
	if (typeof subscribed !== 'boolean') {
		throw new StoreError('INVALID', 'isSubscribed is true or false');
	}
	if (mailbox.isSubscribed !== subscribed) {
		mailbox.isSubscribed = subscribed;
		mailbox.modseq = state.bump(mailbox.accountId);
	}
	return state.mailboxView(mailbox);
}

export function deleteMailbox(
	state: MemoryState,
	id: string,
	removeMessages: boolean,
): Expunged[] {
	const mailbox = state.mailbox(id);
	for (const other of state.mailboxes.values()) {
		if (other.parentId === id) {
			throw new StoreError(
				'INVALID',
				'A mailbox with children cannot be deleted',
			);
		}
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
