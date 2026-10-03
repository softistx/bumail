import {
	accountMessageItems,
	type DestroyedRow,
	type ExpungedRow,
	expungedItems,
	type LiveRow,
	type MailboxRow,
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
import type { SqliteState } from './state';

/** What was destroyed after `since`: messages or mailboxes. */
function destroyedSince(
	state: SqliteState,
	accountId: string,
	kind: 'message' | 'mailbox',
	since: number,
): DestroyedRow[] {
	return state.db
		.query<DestroyedRow, [string, string, number]>(
			`SELECT id, modseq, created_modseq AS createdModseq FROM tombstones
			WHERE account_id = ? AND kind = ? AND modseq > ? ORDER BY seq`,
		)
		.all(accountId, kind, since);
}

/** The departures after `since`: from one mailbox, or from any. */
function expungedSince(
	state: SqliteState,
	accountId: string,
	mailboxId: string | undefined,
	since: number,
): ExpungedRow[] {
	return state.db
		.query<ExpungedRow, [string, number, string | null]>(
			`SELECT id AS messageId, mailbox_id AS mailboxId, uid, modseq,
				joined_modseq AS joinedModseq
			FROM tombstones
			WHERE account_id = ?1 AND kind = 'expunged' AND modseq > ?2
				AND (?3 IS NULL OR mailbox_id = ?3)
			ORDER BY seq`,
		)
		.all(accountId, since, mailboxId ?? null);
}

/** The account's messages changed after `since`. */
function messagesSince(
	state: SqliteState,
	accountId: string,
	since: number,
): LiveRow[] {
	return state.db
		.query<LiveRow, [string, number]>(
			`SELECT id, created_modseq AS createdModseq, modseq FROM messages
			WHERE account_id = ? AND modseq > ? ORDER BY created_modseq`,
		)
		.all(accountId, since);
}

/** The messages in a mailbox changed after `since`, with when each came in. */
function membersSince(
	state: SqliteState,
	mailboxId: string,
	since: number,
): MemberRow[] {
	return state.db
		.query<MemberRow, [string, number]>(
			`SELECT m.id, ms.joined_modseq AS joinedModseq, m.modseq
			FROM memberships ms JOIN messages m ON m.id = ms.message_id
			WHERE ms.mailbox_id = ? AND m.modseq > ? ORDER BY m.created_modseq`,
		)
		.all(mailboxId, since);
}

/** What changed among the account's messages since a modseq. */
export function messageChanges(
	state: SqliteState,
	accountId: string,
	since: number,
	options: MessageChangesOptions,
): MessageChanges {
	const account = state.account(accountId);
	const { mailboxId } = options;
	if (mailboxId !== undefined) state.mailbox(accountId, mailboxId);
	checkSince(account, since, options);
	const expunged = expungedSince(state, accountId, mailboxId, since);
	const items =
		mailboxId === undefined
			? accountMessageItems(
					messagesSince(state, accountId, since),
					destroyedSince(state, accountId, 'message', since),
					since,
				)
			: mailboxMessageItems(
					membersSince(state, mailboxId, since),
					expunged,
					since,
				);
	for (const item of expungedItems(expunged, since)) items.push(item);
	return messageChangesOf(account, items, options.limit);
}

/** What changed among the account's mailboxes since a modseq. */
export function mailboxChanges(
	state: SqliteState,
	accountId: string,
	since: number,
	options: ChangesOptions,
): MailboxChanges {
	const account = state.account(accountId);
	checkSince(account, since, options);
	const live = state.db
		.query<MailboxRow, [string, number]>(
			`SELECT id, created_modseq AS createdModseq, modseq, highest_modseq AS highestModseq
			FROM mailboxes WHERE account_id = ? AND max(modseq, highest_modseq) > ?`,
		)
		.all(accountId, since);
	return mailboxChangesOf(
		account,
		mailboxItems(
			live,
			destroyedSince(state, accountId, 'mailbox', since),
			since,
		),
		options.limit,
	);
}
