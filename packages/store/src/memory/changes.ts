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
	/** Where it sorts: its creation for a created item, else its last change. */
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
	// Since 0 needs no tombstone: everything that exists is created.
	if (since > 0 && since < account.floor) {
		throw new StoreError(
			'CANNOT_CALCULATE_CHANGES',
			`Changes since ${since} are forgotten; ask for the changes since 0, which lists every message as created`,
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
 * `limit`. A created item sorts by its creation, so a page that ends past
 * it lists it as created even when it changed again later; the next page
 * then lists that change as an update (RFC 8620 §5.2's intermediate
 * states). A thing created and destroyed since is left out. A cut never
 * splits items of one modseq: a page goes over `limit` only when one
 * modseq alone holds more.
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
		const created = thing.createdModseq > since;
		items.push({
			id: thing.id,
			modseq: created ? thing.createdModseq : thing.modseq,
			kind: created ? 'created' : 'updated',
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
	let last = (items[limit - 1] as Item).modseq;
	let kept = items.filter((item) => item.modseq <= last);
	if (kept.length > limit) {
		// Items of one modseq straddle the limit: stop before them, unless
		// they alone fill the page.
		const before = items.filter((item) => item.modseq < last);
		if (before.length > 0) {
			kept = before;
			last = (before.at(-1) as Item).modseq;
		}
	}
	if (kept.length === items.length) {
		return { items, modseq: account.modseq, hasMore: false };
	}
	return { items: kept, modseq: last, hasMore: true };
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
	// Since 0, the client holds nothing that could have vanished.
	for (const tombstone of since === 0 ? [] : account.tombstones) {
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
