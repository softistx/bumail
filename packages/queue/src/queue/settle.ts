import type {
	AttemptResult,
	QueueItem,
	RecipientUpdate,
} from '../contract/types';
import { nextAttemptAt } from './retry';
import type { Settings } from './settings';

/** An attempt's outcomes, sorted, and what to record and send for them. */
export interface Settled {
	readonly result: AttemptResult;
	readonly delivered: readonly RecipientUpdate[];
	/** Failed in this attempt: a 5xx, or given up. */
	readonly failed: readonly RecipientUpdate[];
	/** Still deferred, to try again at `result.nextAttemptAt`. */
	readonly deferred: readonly RecipientUpdate[];
	/** A "delayed" DSN is due for the deferred recipients. */
	readonly delayDsn: boolean;
}

/**
 * A deferred recipient past the moment of giving up: failed, as X.4.7
 * (RFC 3463 §3.5, delivery time expired), the remote reply's code and text
 * kept as they were said.
 */
function expired(update: RecipientUpdate): RecipientUpdate {
	return {
		address: update.address,
		status: 'failed',
		reply: { text: '', ...update.reply, status: '4.4.7' },
	};
}

/**
 * What an attempt comes to: the count, the next attempt (RFC 5321
 * §4.5.4.1's back-off, or now when some recipients were left out because
 * the worker is stopping), the deferred recipients that gave up, and
 * whether the "delayed" DSN is due — once, for a sender that is not null.
 */
export function settle(
	item: QueueItem,
	updates: readonly RecipientUpdate[],
	skipped: boolean,
	now: number,
	settings: Settings,
): Settled {
	const attempts = item.attempts + (updates.length > 0 ? 1 : 0);
	const next = nextAttemptAt(
		item.createdAt,
		now,
		attempts,
		settings.retry,
		settings.random,
	);
	const all = updates.map((u) =>
		u.status === 'deferred' && next === undefined ? expired(u) : u,
	);
	const deferred = all.filter((u) => u.status === 'deferred');
	const { delayAfter } = settings.dsn;
	const delayDsn =
		!item.delayNotified &&
		item.from !== '' &&
		delayAfter !== false &&
		deferred.length > 0 &&
		now - item.createdAt >= delayAfter;
	return {
		result: {
			now,
			recipients: all,
			// Left out by a stop with nothing deferred: due at once. Otherwise the
			// back-off holds for the whole item, the left-out domains included.
			nextAttemptAt:
				next === undefined || (skipped && deferred.length === 0) ? now : next,
			attempts,
			delayNotified: item.delayNotified || delayDsn,
		},
		delivered: all.filter((u) => u.status === 'delivered'),
		failed: all.filter((u) => u.status === 'failed'),
		deferred,
		delayDsn,
	};
}
