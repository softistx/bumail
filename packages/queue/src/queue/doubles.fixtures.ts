import type { QueueStore } from '../contract/queue-store';
import type { AttemptResult, QueueItem } from '../contract/types';
import { createQueue } from './queue';
import {
	fakeClock,
	fakeSender,
	NO_DNS,
	recordEvents,
	type Script,
} from './queue.fixtures';

/**
 * Takes an item's message out of `store`, as damage would — a Redis key
 * evicted or deleted, a row removed by hand — and leaves the item.
 */
export type LoseMessage = (store: QueueStore, id: string) => Promise<void>;

/**
 * `store` seen through a handle whose `readMessage` gives nothing for the
 * ids `lose` names: for a store no spec can damage from outside, as the
 * memory store.
 */
export function hidingMessages(store: QueueStore): {
	store: QueueStore;
	lose: LoseMessage;
} {
	const lost = new Set<string>();
	const seen = new Proxy(store, {
		get(target, key) {
			if (key === 'readMessage') {
				return async (id: string) =>
					lost.has(id) ? undefined : target.readMessage(id);
			}
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return {
		store: seen,
		lose: async (_store, id) => {
			lost.add(id);
		},
	};
}

export type Complete = (
	target: QueueStore,
	id: string,
	owner: string,
	result: AttemptResult,
) => Promise<QueueItem | undefined>;

/** `store` with its `complete` replaced, every other method its own. */
export function completing(store: QueueStore, complete: Complete): QueueStore {
	return new Proxy(store, {
		get(target, key) {
			if (key === 'complete') {
				return (id: string, owner: string, result: AttemptResult) =>
					complete(target, id, owner, result);
			}
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/** A queue on `store`, one worker `w`, with room for one item. */
export function instance(store: QueueStore, script?: Script) {
	const clock = fakeClock();
	const sender = fakeSender(script);
	const queue = createQueue({
		store,
		hostname: 'mail.example.net',
		resolver: NO_DNS,
		clock,
		send: sender.send,
		random: () => 0,
		owner: 'w',
		limits: { maxItems: 1 },
	});
	return { queue, clock, sender, events: recordEvents(queue) };
}
