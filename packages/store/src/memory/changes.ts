import type {
	ChangesOptions,
	Expunged,
	MailboxChanges,
	MessageChanges,
} from '../contract/types';
import { StoreError } from '../errors';
import type { AccountState, MemoryState } from './state';

interface Item {
	id: string;
	modseq: number;
	kind: 'created' | 'updated' | 'destroyed';
}

function checkSince(
	account: AccountState,
	since: number,
	options: ChangesOptions,
): void {
	if (!Number.isSafeInteger(since) || since < 0 || since > account.modseq) {
		throw new StoreError(
			'INVALID',
			`since must be a modseq the account has given, from 0 to ${account.modseq}, not ${since}`,
		);
	}
	if (since < account.floor) {
		throw new StoreError(
			'CANNOT_CALCULATE_CHANGES',
			`Changes since ${since} are forgotten; start again from 0`,
		);
	}
	const limit = options.limit;
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
		throw new StoreError(
			'INVALID',
			`limit must be a positive integer, not ${limit}`,
		);
	}
}

/**
 * The live items and the tombstones after `since`, oldest first, cut at
 * `limit`. A thing created and destroyed since is left out.
 */
function page(
	account: AccountState,
	since: number,
	live: Iterable<{ id: string; createdModseq: number; modseq: number }>,
	kind: 'message' | 'mailbox',
	limit: number | undefined,
): { items: Item[]; modseq: number; hasMore: boolean } {
	const items: Item[] = [];
	for (const thing of live) {
		if (thing.modseq <= since) continue;
		items.push({
			id: thing.id,
			modseq: thing.modseq,
			kind: thing.createdModseq > since ? 'created' : 'updated',
		});
	}
	for (const tombstone of account.tombstones) {
		if (
			tombstone.kind === kind &&
			tombstone.modseq > since &&
			tombstone.createdModseq <= since
		) {
			items.push({
				id: tombstone.id,
				modseq: tombstone.modseq,
				kind: 'destroyed',
			});
		}
	}
	items.sort((a, b) => a.modseq - b.modseq);
	if (limit === undefined || items.length <= limit) {
		return { items, modseq: account.modseq, hasMore: false };
	}
	const kept = items.slice(0, limit);
	return { items: kept, modseq: (kept.at(-1) as Item).modseq, hasMore: true };
}

const ids = (items: Item[], kind: Item['kind']) =>
	items.filter((item) => item.kind === kind).map((item) => item.id);

export function messageChanges(
	state: MemoryState,
	accountId: string,
	since: number,
	options: ChangesOptions,
): MessageChanges {
	const account = state.account(accountId);
	checkSince(account, since, options);
	const live = [...state.messages.values()].filter(
		(message) => message.accountId === accountId,
	);
	const { items, modseq, hasMore } = page(
		account,
		since,
		live,
		'message',
		options.limit,
	);
	const expunged: Expunged[] = [];
	for (const tombstone of account.tombstones) {
		if (
			tombstone.kind === 'expunged' &&
			tombstone.modseq > since &&
			tombstone.modseq <= modseq
		) {
			const { kind: _, ...rest } = tombstone;
			expunged.push(rest);
		}
	}
	return {
		modseq,
		hasMore,
		created: ids(items, 'created'),
		updated: ids(items, 'updated'),
		destroyed: ids(items, 'destroyed'),
		expunged,
	};
}

export function mailboxChanges(
	state: MemoryState,
	accountId: string,
	since: number,
	options: ChangesOptions,
): MailboxChanges {
	const account = state.account(accountId);
	checkSince(account, since, options);
	// A mailbox whose messages changed changed too: its counts are its own.
	const live = [...state.mailboxes.values()]
		.filter((mailbox) => mailbox.accountId === accountId)
		.map((mailbox) => ({
			id: mailbox.id,
			createdModseq: mailbox.createdModseq,
			modseq: Math.max(mailbox.modseq, mailbox.highestModseq),
		}));
	const { items, modseq, hasMore } = page(
		account,
		since,
		live,
		'mailbox',
		options.limit,
	);
	return {
		modseq,
		hasMore,
		created: ids(items, 'created'),
		updated: ids(items, 'updated'),
		destroyed: ids(items, 'destroyed'),
	};
}
