import {
	accountMessageItems,
	type DestroyedRow,
	type ExpungedRow,
	expungedItems,
	type MemberRow,
	mailboxChangesOf,
	mailboxItems,
	mailboxMessageItems,
	messageChangesOf,
} from '../contract/changes';
import { checkSince } from '../contract/paging';
import type {
	ChangesOptions,
	MailboxChanges,
	MessageChanges,
	MessageChangesOptions,
} from '../contract/types';
import type { AccountState, MemoryState } from './state';

/** The account's tombstones of a destroyed message or mailbox, oldest first. */
function* destroyedOf(
	account: AccountState,
	kind: 'message' | 'mailbox',
): Generator<DestroyedRow> {
	for (const tombstone of account.tombstones) {
		if (tombstone.kind === kind) yield tombstone;
	}
}

/** The account's departures, oldest first: from one mailbox, or from any. */
function* expungedOf(
	account: AccountState,
	mailboxId: string | undefined,
): Generator<ExpungedRow> {
	for (const tombstone of account.tombstones) {
		if (
			tombstone.kind === 'expunged' &&
			(mailboxId === undefined || tombstone.mailboxId === mailboxId)
		) {
			yield tombstone;
		}
	}
}

/** The messages in a mailbox, with when each came in. */
function* membersOf(
	state: MemoryState,
	mailboxId: string,
): Generator<MemberRow> {
	for (const message of state.messages.values()) {
		const place = message.mailboxes.get(mailboxId);
		if (!place) continue;
		yield {
			id: message.id,
			joinedModseq: place.modseq,
			modseq: message.modseq,
		};
	}
}

/** The things of one account, in insertion order. */
function* ofAccount<T extends { accountId: string }>(
	things: Iterable<T>,
	accountId: string,
): Generator<T> {
	for (const thing of things) if (thing.accountId === accountId) yield thing;
}

export function messageChanges(
	state: MemoryState,
	accountId: string,
	since: number,
	options: MessageChangesOptions,
): MessageChanges {
	const account = state.account(accountId);
	const { mailboxId } = options;
	if (mailboxId !== undefined) state.mailbox(accountId, mailboxId);
	checkSince(account, since, options);
	const items =
		mailboxId === undefined
			? accountMessageItems(
					ofAccount(state.messages.values(), accountId),
					destroyedOf(account, 'message'),
					since,
				)
			: mailboxMessageItems(
					membersOf(state, mailboxId),
					expungedOf(account, mailboxId),
					since,
				);
	for (const item of expungedItems(expungedOf(account, mailboxId), since))
		items.push(item);
	return messageChangesOf(account, items, options.limit);
}

export function mailboxChanges(
	state: MemoryState,
	accountId: string,
	since: number,
	options: ChangesOptions,
): MailboxChanges {
	const account = state.account(accountId);
	checkSince(account, since, options);
	const items = mailboxItems(
		ofAccount(state.mailboxes.values(), accountId),
		destroyedOf(account, 'mailbox'),
		since,
	);
	return mailboxChangesOf(account, items, options.limit);
}
