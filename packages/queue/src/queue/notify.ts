import type { QueueStore } from '../contract/queue-store';
import type { QueueItem, RecipientUpdate } from '../contract/types';
import { buildDsn, type DsnKind } from '../dsn/build';
import type { Events } from './events';
import { giveUpAt } from './retry';
import type { Settings } from './settings';

export interface NotifyContext {
	readonly settings: Settings;
	readonly store: QueueStore;
	readonly events: Events;
}

/**
 * Enqueues a DSN (RFC 3464) back to the item's sender for these
 * recipients, from the null sender, so it never causes one of its own.
 * Nothing for an item from the null sender (RFC 5321 §4.5.5, RFC 3464
 * §2: a DSN is never sent about a DSN). It bypasses `maxItems`: a full
 * queue loses no bounce. A failure goes to the `error` event.
 */
export async function notify(
	ctx: NotifyContext,
	item: QueueItem,
	message: Uint8Array,
	kind: DsnKind,
	recipients: readonly RecipientUpdate[],
	now: number,
): Promise<void> {
	if (item.from === '' || recipients.length === 0) return;
	const { settings, store, events } = ctx;
	try {
		const lastAttempt = new Date(now);
		const dsn = buildDsn({
			kind,
			reportingMta: settings.hostname,
			from: settings.dsn.from,
			to: item.from,
			arrival: new Date(item.createdAt),
			date: lastAttempt,
			recipients: recipients.map((r) => ({
				address: r.address,
				...(r.reply ? { reply: r.reply } : {}),
				lastAttempt,
			})),
			...(kind === 'delayed'
				? { willRetryUntil: new Date(giveUpAt(item.createdAt, settings.retry)) }
				: {}),
			original: message,
			returnContent: settings.dsn.returnContent,
			maxReturn: settings.limits.maxDsnReturn,
		});
		const added = await store.add({
			from: '',
			to: [item.from],
			message: dsn,
			createdAt: now,
		});
		events.emit('dsn', {
			kind,
			id: added.id,
			of: item.id,
			to: item.from,
			recipients: recipients.map((r) => r.address),
		});
	} catch (error) {
		events.emit('error', { error, id: item.id });
	}
}
