import type {
	ChangesOptions,
	MailboxChanges,
	MessageChanges,
	MessageChangesOptions,
} from '../contract/types';
import { checkSince, type Item, ids, liveItem, page } from './paging';
import type { AccountState, MemoryState, Tombstone } from './state';

type ExpungedTombstone = Extract<Tombstone, { kind: 'expunged' }>;

const expungedItem = ({
	kind: _,
	joinedModseq: __,
	...expunged
}: ExpungedTombstone): Item => ({
	id: expunged.messageId,
	modseq: expunged.modseq,
	kind: 'expunged',
	expunged,
});

/** Every message of the account, destroyed since or changed since. */
function accountItems(
	state: MemoryState,
	account: AccountState,
	accountId: string,
	since: number,
): Item[] {
	const items: Item[] = [];
	for (const message of state.messages.values()) {
		if (message.accountId !== accountId) continue;
		const item = liveItem(message, since);
		if (item) items.push(item);
	}
	for (const tombstone of account.tombstones) {
		// A thing created and destroyed since is left out.
		if (
			tombstone.kind === 'message' &&
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
	return items;
}

/**
 * The messages of one mailbox as if it were the account: one that came in
 * since is created, sorted by its first coming in, as a created item sorts
 * by its creation; one that was in it at `since` and is no more is
 * destroyed, when it left. One that left and came back is updated.
 */
function mailboxItems(
	state: MemoryState,
	account: AccountState,
	mailboxId: string,
	since: number,
): Item[] {
	const left = new Map<string, number>();
	const firstJoined = new Map<string, number>();
	for (const tombstone of account.tombstones) {
		if (
			tombstone.kind !== 'expunged' ||
			tombstone.mailboxId !== mailboxId ||
			tombstone.modseq <= since
		) {
			continue;
		}
		const id = tombstone.messageId;
		if (tombstone.joinedModseq <= since) left.set(id, tombstone.modseq);
		else if (!firstJoined.has(id)) firstJoined.set(id, tombstone.joinedModseq);
	}
	const items: Item[] = [];
	for (const message of state.messages.values()) {
		const place = message.mailboxes.get(mailboxId);
		if (!place) continue;
		const createdModseq = firstJoined.get(message.id) ?? place.modseq;
		const item = liveItem(
			{ id: message.id, createdModseq, modseq: message.modseq },
			since,
			left.delete(message.id),
		);
		if (item) items.push(item);
	}
	for (const [id, modseq] of left)
		items.push({ id, modseq, kind: 'destroyed' });
	return items;
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
			? accountItems(state, account, accountId, since)
			: mailboxItems(state, account, mailboxId, since);
	// RFC 7162 §3.2.6: every UID expunged after `since`, even one the client
	// may never have seen; a client ignores a UID it does not hold. Since 0,
	// the client holds nothing that could have vanished.
	for (const tombstone of since === 0 ? [] : account.tombstones) {
		if (
			tombstone.kind === 'expunged' &&
			tombstone.modseq > since &&
			(mailboxId === undefined || tombstone.mailboxId === mailboxId)
		) {
			items.push(expungedItem(tombstone));
		}
	}
	const { items: kept, modseq, hasMore } = page(account, items, options.limit);
	return {
		modseq,
		hasMore,
		created: ids(kept, 'created'),
		updated: ids(kept, 'updated'),
		destroyed: ids(kept, 'destroyed'),
		expunged: kept.flatMap((item) => (item.expunged ? [item.expunged] : [])),
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
	const items: Item[] = [];
	for (const mailbox of state.mailboxes.values()) {
		if (mailbox.accountId !== accountId) continue;
		// A mailbox whose messages changed changed too: its counts are its own.
		const item = liveItem(
			{
				id: mailbox.id,
				createdModseq: mailbox.createdModseq,
				modseq: Math.max(mailbox.modseq, mailbox.highestModseq),
			},
			since,
		);
		if (item) items.push(item);
	}
	for (const tombstone of account.tombstones) {
		if (
			tombstone.kind === 'mailbox' &&
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
	const { items: kept, modseq, hasMore } = page(account, items, options.limit);
	return {
		modseq,
		hasMore,
		created: ids(kept, 'created'),
		updated: ids(kept, 'updated'),
		destroyed: ids(kept, 'destroyed'),
	};
}
