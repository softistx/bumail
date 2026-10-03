import { invalid } from '../errors';
import type {
	AttemptResult,
	ClaimRequest,
	NewQueueItem,
	QueueItem,
	QueueListOptions,
	RecipientState,
} from './types';

/** What every store checks the same way, so each refuses the same input with the same error. */

const isTime = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/** A time in milliseconds since the epoch, or `INVALID` naming it. */
export function checkTime(name: string, value: unknown): number {
	if (!isTime(value)) throw invalid(`${name} must be a finite number`);
	return value;
}

/** A lease owner: a non-empty string. */
export function checkOwner(owner: unknown): string {
	if (typeof owner !== 'string' || owner === '') {
		throw invalid('owner must be a non-empty string');
	}
	return owner;
}

export function checkNewItem(item: NewQueueItem): void {
	if (typeof item !== 'object' || item === null) {
		throw invalid('A new item is an object');
	}
	if (typeof item.from !== 'string') throw invalid('from must be a string');
	const to = item.to as unknown;
	if (
		!Array.isArray(to) ||
		to.length === 0 ||
		!to.every((a) => typeof a === 'string' && a !== '')
	) {
		throw invalid('to must be a non-empty array of addresses');
	}
	if (!(item.message instanceof Uint8Array)) {
		throw invalid('message must be a Uint8Array');
	}
	checkTime('createdAt', item.createdAt);
}

/** `maxItems`: a positive integer, or nothing. */
export function checkMaxItems(max: unknown): number | undefined {
	if (max === undefined) return undefined;
	if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
		throw invalid(`maxItems must be an integer of at least 1, not ${max}`);
	}
	return max;
}

export function checkClaim(request: ClaimRequest): void {
	if (typeof request !== 'object' || request === null) {
		throw invalid('A claim is an object');
	}
	checkOwner(request.owner);
	checkTime('now', request.now);
	if (!isTime(request.leaseMs) || request.leaseMs <= 0) {
		throw invalid('leaseMs must be a positive number');
	}
}

export function checkResult(result: AttemptResult): void {
	if (typeof result !== 'object' || result === null) {
		throw invalid('An attempt result is an object');
	}
	checkTime('now', result.now);
	checkTime('nextAttemptAt', result.nextAttemptAt);
	if (!Number.isInteger(result.attempts) || result.attempts < 0) {
		throw invalid('attempts must be an integer of at least 0');
	}
	if (!Array.isArray(result.recipients)) {
		throw invalid('recipients must be an array');
	}
}

/** The offset and limit of a list: integers, the limit 1 to 1000. */
export function checkList(options: QueueListOptions = {}): {
	offset: number;
	limit: number;
} {
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 100;
	if (!Number.isInteger(offset) || offset < 0) {
		throw invalid(`offset must be an integer of at least 0, not ${offset}`);
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw invalid(`limit must be an integer from 1 to 1000, not ${limit}`);
	}
	return { offset, limit };
}

/** Every recipient is `delivered` or `failed`. */
export const isDone = (item: Pick<QueueItem, 'recipients'>): boolean =>
	item.recipients.every(
		(r) => r.status === 'delivered' || r.status === 'failed',
	);

/**
 * The item once an attempt is recorded: its recipients' outcomes, a final
 * state never changed again, the schedule, and no lease.
 */
export function applyAttempt(
	item: QueueItem,
	result: AttemptResult,
): QueueItem {
	const updates = new Map(result.recipients.map((u) => [u.address, u]));
	const recipients = item.recipients.map((r): RecipientState => {
		const update = updates.get(r.address);
		if (!update || r.status === 'delivered' || r.status === 'failed') return r;
		return {
			address: r.address,
			status: update.status,
			...(update.reply ? { reply: update.reply } : {}),
			updatedAt: result.now,
		};
	});
	const { lease: _, ...rest } = item;
	return {
		...rest,
		recipients,
		nextAttemptAt: result.nextAttemptAt,
		attempts: result.attempts,
		delayNotified: result.delayNotified,
	};
}

/** A new item as a store first keeps it. */
export function newItem(id: string, item: NewQueueItem): QueueItem {
	return {
		id,
		from: item.from,
		recipients: item.to.map((address) => ({ address, status: 'pending' })),
		size: item.message.length,
		createdAt: item.createdAt,
		nextAttemptAt: item.createdAt,
		attempts: 0,
		delayNotified: false,
	};
}

/** Whether a lease, if any, leaves the item free to claim at `now`. */
export const claimable = (item: QueueItem, now: number): boolean =>
	item.nextAttemptAt <= now &&
	(item.lease === undefined || item.lease.expiresAt <= now);
