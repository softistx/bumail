import { StoreError } from '../errors';
import type { ChangesOptions, Expunged } from './types';

/** Where an account's modseqs stand: any store's account state fits it. */
export interface Counter {
	/** The account's last modseq. */
	readonly modseq: number;
	/** The oldest `since` still answered: tombstones before it were pruned. */
	readonly floor: number;
}

export interface Item {
	id: string;
	/** Where it sorts: its creation for a created item, else its last change. */
	modseq: number;
	kind: 'created' | 'updated' | 'destroyed' | 'expunged';
	/** For an expunged item: what left which mailbox. */
	expunged?: Expunged;
}

/** Refuses a `since` the account never gave or has forgotten, and a bad `limit`. */
export function checkSince(
	account: Counter,
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
			`Changes since ${since} are forgotten; ask for the changes since 0, which lists every item as created`,
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
 * A live thing as a changes item since `since`, or `undefined` when it has
 * not changed since. `existedAt` says it was there at `since` even though
 * `createdModseq` is later — a message back in a mailbox it had left.
 */
export function liveItem(
	thing: { id: string; createdModseq: number; modseq: number },
	since: number,
	existedAt = false,
): Item | undefined {
	if (thing.modseq <= since) return undefined;
	const created = thing.createdModseq > since && !existedAt;
	return {
		id: thing.id,
		modseq: created ? thing.createdModseq : thing.modseq,
		kind: created ? 'created' : 'updated',
	};
}

/**
 * The items, oldest first, cut at `limit`. A created item sorts by its
 * creation, so a page that ends past it lists it as created even when it
 * changed again later; the next page then lists that change as an update
 * (RFC 8620 §5.2's intermediate states). A cut never splits items of one
 * modseq: a page goes over `limit` only when one modseq alone holds more,
 * or to reach the account's floor, below which the next page could not be
 * answered.
 *
 * A store that cuts in its database passes only the items up to a modseq
 * at or past both the floor and the item after the `limit`th, and `more`
 * when it left items out: the page is the one all the items would give.
 */
export function page(
	account: Counter,
	items: Item[],
	limit: number | undefined,
	more = false,
): { items: Item[]; modseq: number; hasMore: boolean } {
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
	// The next page asks since `last`: one below the floor would be
	// CANNOT_CALCULATE_CHANGES, so a since-0 page reaches the floor at least.
	if (last < account.floor) {
		last = account.floor;
		kept = items.filter((item) => item.modseq <= last);
	}
	if (kept.length === items.length && !more) {
		return { items, modseq: account.modseq, hasMore: false };
	}
	return { items: kept, modseq: last, hasMore: true };
}

/** The ids of the items of one kind, in order. */
export const ids = (items: Item[], kind: Item['kind']) =>
	items.filter((item) => item.kind === kind).map((item) => item.id);
