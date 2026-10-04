import type { QueueItem } from '../contract/types';
import { QueueError } from '../errors';
import type { NotifyContext } from './notify';

/**
 * How a lease was lost. `taken`: a renewal found the item still in the
 * store, held by another worker or by none. `expired`: the lease's last
 * expiry passed, so another worker could claim it.
 */
export type Lapse = 'taken' | 'expired';

/** What a worker knows of its lease on an item it delivers. */
export interface LeaseState {
	readonly item: QueueItem;
	/** The outcome is recorded, or a renewal was refused: no more renewals count. */
	done: boolean;
	/** The lease's last expiry this worker set: the claim's, then each renewal's. */
	expiresAt: number;
	/** A renewal was refused while the item was still in the store. */
	taken: boolean;
	/** The look a refused renewal takes at the item. */
	looking: Promise<void>;
}

export function leaseOf(ctx: NotifyContext, item: QueueItem): LeaseState {
	const { settings } = ctx;
	return {
		item,
		done: false,
		expiresAt: item.lease?.expiresAt ?? settings.now() + settings.leaseMs,
		taken: false,
		looking: Promise.resolve(),
	};
}

/** After a refused renewal: an item still there was taken, and is said so; a gone one is left to `lapsed`. */
async function lookAfterRefusal(
	ctx: NotifyContext,
	lease: LeaseState,
): Promise<void> {
	const { id } = lease.item;
	if ((await ctx.store.get(id)) === undefined) return;
	lease.taken = true;
	const error = new QueueError(
		'LEASE_LOST',
		`The lease on ${id} was lost while it was delivered`,
	);
	ctx.events.emit('error', { error, id });
}

/**
 * One renewal. A renewal that is held keeps its expiry, even one that
 * lands after the outcome is recorded. One refused while the item is
 * still there — held by another worker or by none — says so once, and
 * ends the renewals; one refused for an item gone says nothing and ends
 * them: a cancel, or another worker that finished it, which `lapsed` tells
 * apart by the expiry. One that fails (the store busy, unreachable) says
 * so, and the next one tries again: the lease may still be held.
 * Resolves `false` once no more renewals are wanted.
 */
export async function renew(
	ctx: NotifyContext,
	lease: LeaseState,
): Promise<boolean> {
	const { settings, store, events } = ctx;
	const { id } = lease.item;
	const next = settings.now() + settings.leaseMs;
	let held: boolean;
	try {
		held = await store.renew(id, settings.owner, next);
	} catch (error) {
		if (!lease.done) events.emit('error', { error, id });
		return !lease.done;
	}
	if (held) lease.expiresAt = Math.max(lease.expiresAt, next);
	if (lease.done) return false;
	if (held) return true;
	lease.done = true;
	lease.looking = lookAfterRefusal(ctx, lease).catch((error: unknown) => {
		events.emit('error', { error, id });
	});
	return false;
}

/**
 * Whether the lease could have passed to another worker by `now`: a
 * renewal found it taken, or its last expiry is past. `undefined` while
 * it surely held, by this worker's clock.
 */
export async function lapsed(
	lease: LeaseState,
	now: number,
): Promise<Lapse | undefined> {
	await lease.looking;
	if (lease.taken) return 'taken';
	return lease.expiresAt <= now ? 'expired' : undefined;
}

/** Resolves once the look a refused renewal took at the item is over. */
export const settled = (lease: LeaseState): Promise<void> => lease.looking;
