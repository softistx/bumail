import type { QueueItem, RecipientUpdate } from '../contract/types';
import { QueueError } from '../errors';
import { domainOf } from './envelope';
import type { Events } from './events';
import type { KeyedLimiter } from './limiter';
import { type NotifyContext, notify } from './notify';
import { outcomesOf, outcomesOfError } from './outcome';
import { hostOf, routeOf, sendOptionsOf } from './route';
import { type Settled, settle } from './settle';

export interface DeliveryContext extends NotifyContext {
	readonly domains: KeyedLimiter;
	readonly events: Events;
	/** The worker is stopping: a group not started yet is left for later. */
	readonly stopping: () => boolean;
	/** The outcome is recorded: the lease needs no more renewal. */
	readonly recorded: () => void;
}

/** The recipients still to deliver, by domain. */
function groupsOf(item: QueueItem): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const r of item.recipients) {
		if (r.status === 'delivered' || r.status === 'failed') continue;
		const domain = domainOf(r.address);
		const group = groups.get(domain);
		if (group) group.push(r.address);
		else groups.set(domain, [r.address]);
	}
	return groups;
}

/** One session for one domain's recipients: each one's outcome, whatever happened. */
async function attemptGroup(
	ctx: DeliveryContext,
	item: QueueItem,
	message: Uint8Array,
	domain: string,
	group: readonly string[],
): Promise<RecipientUpdate[]> {
	const { settings } = ctx;
	const max = settings.limits.maxReplyText;
	try {
		const options = sendOptionsOf(settings, domain, item.from, group);
		return outcomesOf(await settings.send(message, options), group, max);
	} catch (error) {
		const host = hostOf(routeOf(settings, domain));
		return outcomesOfError(error, group, max, host);
	}
}

/** Tells the listeners each recipient's outcome. */
function emitOutcomes(events: Events, item: QueueItem, settled: Settled): void {
	const { attempts, nextAttemptAt } = settled.result;
	const base = (u: RecipientUpdate) => ({
		id: item.id,
		from: item.from,
		recipient: u.address,
		...(u.reply ? { reply: u.reply } : {}),
		attempts,
	});
	for (const u of settled.delivered) events.emit('delivered', base(u));
	for (const u of settled.deferred) {
		events.emit('deferred', { ...base(u), nextAttemptAt });
	}
	for (const u of settled.failed) events.emit('failed', base(u));
}

/**
 * Delivers a claimed item: one session per recipient domain, at most
 * `perDomain` at once to each, then the outcome recorded — which lets go
 * of the lease — then the events and the DSNs.
 */
export async function deliverItem(
	ctx: DeliveryContext,
	item: QueueItem,
): Promise<void> {
	const { settings, store, events } = ctx;
	const message = await store.readMessage(item.id);
	if (!message) return;
	let skipped = false;
	const outcomes = await Promise.all(
		[...groupsOf(item)].map(async ([domain, group]) => {
			const release = await ctx.domains.acquire(domain);
			try {
				if (ctx.stopping()) {
					skipped = true;
					return [];
				}
				return await attemptGroup(ctx, item, message, domain, group);
			} finally {
				release();
			}
		}),
	);
	const now = settings.now();
	const settled = settle(item, outcomes.flat(), skipped, now, settings);
	const after = await store.complete(item.id, settings.owner, settled.result);
	ctx.recorded();
	if (!after && (await store.get(item.id)) === undefined) {
		// Cancelled meanwhile: what the sessions did still happened; no DSN.
		emitOutcomes(events, item, settled);
		return;
	}
	if (!after) {
		const error = new QueueError(
			'LEASE_LOST',
			`The lease on ${item.id} was lost before its outcome was recorded; another worker will try it again`,
		);
		events.emit('error', { error, id: item.id });
		return;
	}
	emitOutcomes(events, item, settled);
	await notify(ctx, item, message, 'failed', settled.failed, now);
	if (settled.delayDsn) {
		await notify(ctx, item, message, 'delayed', settled.deferred, now);
	}
}
