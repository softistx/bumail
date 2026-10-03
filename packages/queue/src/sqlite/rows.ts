import type { QueueItem, RecipientState } from '../contract/types';

/** A row of `items`, as `bun:sqlite` reads it. */
export interface ItemRow {
	readonly id: string;
	readonly sender: string;
	readonly recipients: string;
	readonly size: number;
	readonly created_at: number;
	readonly next_attempt_at: number;
	readonly attempts: number;
	readonly delay_notified: number;
	readonly lease_owner: string | null;
	readonly lease_expires_at: number | null;
}

/** The columns a query reads to build an item. */
export const COLUMNS =
	'id, sender, recipients, size, created_at, next_attempt_at, attempts, delay_notified, lease_owner, lease_expires_at';

export function itemOf(row: ItemRow): QueueItem {
	const item: QueueItem = {
		id: row.id,
		from: row.sender,
		recipients: JSON.parse(row.recipients) as RecipientState[],
		size: row.size,
		createdAt: row.created_at,
		nextAttemptAt: row.next_attempt_at,
		attempts: row.attempts,
		delayNotified: row.delay_notified === 1,
	};
	if (row.lease_owner === null || row.lease_expires_at === null) return item;
	return {
		...item,
		lease: { owner: row.lease_owner, expiresAt: row.lease_expires_at },
	};
}

/** The named parameters that write an item's state back. */
export function stateOf(item: QueueItem) {
	return {
		id: item.id,
		recipients: JSON.stringify(item.recipients),
		next_attempt_at: item.nextAttemptAt,
		attempts: item.attempts,
		delay_notified: item.delayNotified ? 1 : 0,
		lease_owner: item.lease?.owner ?? null,
		lease_expires_at: item.lease?.expiresAt ?? null,
	};
}
