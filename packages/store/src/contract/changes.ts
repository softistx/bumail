import { type Counter, type Item, ids, liveItem, page } from './paging';
import type { Expunged, MailboxChanges, MessageChanges } from './types';

/** A live thing as the changes see it: when it was created and last changed. */
export interface LiveRow {
	readonly id: string;
	readonly createdModseq: number;
	readonly modseq: number;
}

/** A thing destroyed at `modseq`, remembered with its creation. */
export interface DestroyedRow {
	readonly id: string;
	readonly modseq: number;
	readonly createdModseq: number;
}

/** A message still in a mailbox: `joinedModseq` is when it came in. */
export interface MemberRow {
	readonly id: string;
	readonly joinedModseq: number;
	readonly modseq: number;
}

/** A message that left a mailbox at `modseq`, having come in at `joinedModseq`. */
export interface ExpungedRow extends Expunged {
	readonly joinedModseq: number;
}

/** The live things changed since, then the destroyed ones that existed at `since`. */
function liveAndDestroyed(
	live: Iterable<LiveRow>,
	destroyed: Iterable<DestroyedRow>,
	since: number,
): Item[] {
	const items: Item[] = [];
	for (const row of live) {
		const item = liveItem(row, since);
		if (item) items.push(item);
	}
	for (const row of destroyed) {
		// A thing created and destroyed since is left out.
		if (row.modseq > since && row.createdModseq <= since) {
			items.push({ id: row.id, modseq: row.modseq, kind: 'destroyed' });
		}
	}
	return items;
}

/** Every message of the account, changed since or destroyed since. */
export function accountMessageItems(
	messages: Iterable<LiveRow>,
	destroyed: Iterable<DestroyedRow>,
	since: number,
): Item[] {
	return liveAndDestroyed(messages, destroyed, since);
}

/**
 * The messages of one mailbox as if it were the account: one that came in
 * since is created, sorted by its first coming in, as a created item sorts
 * by its creation; one that was in it at `since` and is no more is
 * destroyed, when it left. One that left and came back is updated.
 * `expunged` holds that mailbox's departures only, oldest first.
 */
export function mailboxMessageItems(
	members: Iterable<MemberRow>,
	expunged: Iterable<ExpungedRow>,
	since: number,
): Item[] {
	const left = new Map<string, number>();
	const firstJoined = new Map<string, number>();
	for (const row of expunged) {
		if (row.modseq <= since) continue;
		const id = row.messageId;
		if (row.joinedModseq <= since) left.set(id, row.modseq);
		else if (!firstJoined.has(id)) firstJoined.set(id, row.joinedModseq);
	}
	const items: Item[] = [];
	for (const member of members) {
		const createdModseq = firstJoined.get(member.id) ?? member.joinedModseq;
		const item = liveItem(
			{ id: member.id, createdModseq, modseq: member.modseq },
			since,
			left.delete(member.id),
		);
		if (item) items.push(item);
	}
	for (const [id, modseq] of left)
		items.push({ id, modseq, kind: 'destroyed' });
	return items;
}

/**
 * Every departure after `since`, even one the client may never have seen;
 * a client ignores a UID it does not hold (RFC 7162 §3.2.6). Since 0, the
 * client holds nothing that could have vanished: there are none.
 */
export function expungedItems(
	expunged: Iterable<ExpungedRow>,
	since: number,
): Item[] {
	const items: Item[] = [];
	if (since === 0) return items;
	for (const { messageId, mailboxId, uid, modseq } of expunged) {
		if (modseq <= since) continue;
		items.push({
			id: messageId,
			modseq,
			kind: 'expunged',
			expunged: { messageId, mailboxId, uid, modseq },
		});
	}
	return items;
}

/** A live mailbox as the changes see it, with the counts its messages move. */
export interface MailboxRow extends LiveRow {
	/** The last change to any of its messages. */
	readonly highestModseq: number;
}

/** Every mailbox of the account, changed since or destroyed since. */
export function mailboxItems(
	mailboxes: Iterable<MailboxRow>,
	destroyed: Iterable<DestroyedRow>,
	since: number,
): Item[] {
	// A mailbox whose messages changed changed too: its counts are its own.
	const live = (function* () {
		for (const mailbox of mailboxes) {
			yield {
				id: mailbox.id,
				createdModseq: mailbox.createdModseq,
				modseq: Math.max(mailbox.modseq, mailbox.highestModseq),
			};
		}
	})();
	return liveAndDestroyed(live, destroyed, since);
}

/** The answer to `messageChanges`: the items paged at `limit`. */
export function messageChangesOf(
	account: Counter,
	items: Item[],
	limit: number | undefined,
): MessageChanges {
	const { items: kept, modseq, hasMore } = page(account, items, limit);
	return {
		modseq,
		hasMore,
		created: ids(kept, 'created'),
		updated: ids(kept, 'updated'),
		destroyed: ids(kept, 'destroyed'),
		expunged: kept.flatMap((item) => (item.expunged ? [item.expunged] : [])),
	};
}

/** The answer to `mailboxChanges`: the items paged at `limit`. */
export function mailboxChangesOf(
	account: Counter,
	items: Item[],
	limit: number | undefined,
): MailboxChanges {
	const { items: kept, modseq, hasMore } = page(account, items, limit);
	return {
		modseq,
		hasMore,
		created: ids(kept, 'created'),
		updated: ids(kept, 'updated'),
		destroyed: ids(kept, 'destroyed'),
	};
}
