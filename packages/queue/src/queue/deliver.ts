import { isMailbox } from '@bumail/smtp/client';
import type { QueueItem, RecipientUpdate } from '../contract/types';
import { QueueError } from '../errors';
import { domainOf } from './envelope';
import type { Events } from './events';
import type { KeyedLimiter } from './limiter';
import { type NotifyContext, notify } from './notify';
import { isRouteError, outcomesOf, outcomesOfError } from './outcome';
import { hostOf, routeOf, sendOptionsOf } from './route';
import { type Settled, settle } from './settle';

export interface DeliveryContext extends NotifyContext {
	readonly domains: KeyedLimiter;
	readonly events: Events;
	/** The worker is stopping: a group not started yet is left for later. */
	readonly stopping: () => boolean;
	/** The outcome is recorded: the lease needs no more renewal. */
	readonly recorded: () => void;
	/**
	 * Whether the lease could have passed to another worker by `now`: a
	 * renewal found it taken, or its last expiry is past. `undefined` while
	 * it surely held.
	 */
	readonly leaseLapsed: (now: number) => Promise<Lapse | undefined>;
}

/**
 * How a lease was lost. `taken`: a renewal found the item under another
 * worker. `expired`: the lease's expiry passed, so another worker could
 * claim it.
 */
export type Lapse = 'taken' | 'expired';

/**
 * Said when the item is gone at `complete` and the lease had lapsed. With
 * no record of who removed it, `expired` cannot tell another worker that
 * finished it from a cancel, so it names both; either way what this
 * worker sent may have been sent again, and it reports no outcome.
 */
const goneAfter = (lapse: Lapse, id: string): QueueError =>
	new QueueError(
		'LEASE_LOST',
		lapse === 'taken'
			? `The lease on ${id} was lost while it was delivered, and the worker that took it has finished it: the message may have been sent twice`
			: `The lease on ${id} expired before its outcome was recorded, and the item is gone: lost to another worker that finished it, the message then sent twice, or cancelled`,
	);

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

/**
 * A recipient `sendMail` would refuse — kept by a store written to by
 * other code, since `enqueue` refuses it — fails alone, as X.1.3 (bad
 * destination mailbox address syntax), so the session for its domain
 * still goes ahead for the others.
 */
const badAddress = (address: string): RecipientUpdate => ({
	address,
	status: 'failed',
	reply: {
		status: '5.1.3',
		text: 'The address is not one SMTP can carry',
	},
});

/**
 * Every recipient of an item whose sender `sendMail` would refuse — kept
 * by a store written to by other code, since `enqueue` refuses it — fails
 * at once, as X.1.7 (bad sender's mailbox address syntax), rather than be
 * deferred on every attempt until `retry.giveUpAfter`.
 */
const badSender = (address: string): RecipientUpdate => ({
	address,
	status: 'failed',
	reply: {
		status: '5.1.7',
		text: "The sender's address is not one SMTP can carry",
	},
});

/** One session for one domain's recipients: each one's outcome, whatever happened. */
async function attemptGroup(
	ctx: DeliveryContext,
	item: QueueItem,
	message: Uint8Array,
	domain: string,
	recipients: readonly string[],
): Promise<RecipientUpdate[]> {
	const { settings } = ctx;
	const max = settings.limits.maxReplyText;
	const bad = recipients.filter((address) => !isMailbox(address));
	const group = recipients.filter(isMailbox);
	if (group.length === 0) return bad.map(badAddress);
	try {
		const options = sendOptionsOf(settings, domain, item.from, group);
		const result = await settings.send(message, options);
		return [...outcomesOf(result, group, max), ...bad.map(badAddress)];
	} catch (error) {
		// A route sendMail cannot use is the operator's to fix: said, and retried.
		if (isRouteError(error)) ctx.events.emit('error', { error, id: item.id });
		const host = hostOf(routeOf(settings, domain));
		return [
			...outcomesOfError(error, group, max, host),
			...bad.map(badAddress),
		];
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
 * `perDomain` at once to each — none, and no slot taken, when its sender
 * is one `sendMail` would refuse — then the outcome recorded — which lets go
 * of the lease — then the events and the DSNs.
 */
export async function deliverItem(
	ctx: DeliveryContext,
	item: QueueItem,
): Promise<void> {
	const { settings, store, events } = ctx;
	const message = await store.readMessage(item.id);
	if (!message) return;
	const groups = groupsOf(item);
	let skipped = false;
	// A sender sendMail would refuse: no session, no slot, every recipient at once.
	const outcomes =
		item.from !== '' && !isMailbox(item.from)
			? [[...groups.values()].flat().map(badSender)]
			: await Promise.all(
					[...groups].map(async ([domain, group]) => {
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
		const lapse = await ctx.leaseLapsed(now);
		if (lapse) {
			// Lost or cancelled: no outcome told, as when the item is still there.
			events.emit('error', { error: goneAfter(lapse, item.id), id: item.id });
			return;
		}
		// Cancelled under a lease that held: what the sessions did still happened; no DSN.
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
