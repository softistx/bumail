import {
	type DestroyedRow,
	type MailboxRow,
	mailboxChangesOf,
	mailboxItems,
} from '../contract/changes';
import { checkSince } from '../contract/paging';
import type { ChangesOptions, MailboxChanges } from '../contract/types';
import type { SqliteState } from './state';

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
	const destroyed = state.db
		.query<DestroyedRow, [string, number]>(
			`SELECT id, modseq, created_modseq AS createdModseq
			FROM tombstones WHERE account_id = ? AND kind = 'mailbox' AND modseq > ?`,
		)
		.all(accountId, since);
	return mailboxChangesOf(
		account,
		mailboxItems(live, destroyed, since),
		options.limit,
	);
}
