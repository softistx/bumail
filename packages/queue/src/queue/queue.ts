import type { QueueItem, QueueListOptions } from '../contract/types';
import {
	checkEnvelope,
	type MessageSource,
	type QueueEnvelope,
	readMessage,
} from './envelope';
import { Events, type QueueEvents, type QueueListener } from './events';
import type { QueueOptions } from './options';
import { settingsOf } from './settings';
import { Worker } from './worker';

/** The outbound queue: what the app enqueues, delivered across restarts. */
export interface Queue {
	/** This worker's name on its leases. */
	readonly owner: string;
	/**
	 * Takes a message to send — already signed, as it will leave — with its
	 * envelope, and keeps it in the store, every recipient pending, due at
	 * once. Refuses with `INVALID`, `MESSAGE_TOO_BIG`,
	 * `TOO_MANY_RECIPIENTS` or `QUEUE_FULL`. The queue sends whatever it is
	 * given: authenticate the submitter before you enqueue.
	 */
	enqueue(message: MessageSource, envelope: QueueEnvelope): Promise<QueueItem>;
	/** One pass by hand: delivers every item due now; resolves with how many it claimed. */
	deliverDue(): Promise<number>;
	/** Delivers in the background: a pass every `pollInterval`, and at once after `enqueue`. */
	start(): void;
	/** Claims nothing more, lets the deliveries under way end, and gives back the rest. */
	stop(): Promise<void>;
	/** Listens to an event; returns what stops listening. */
	on<E extends keyof QueueEvents>(
		event: E,
		listener: QueueListener<E>,
	): () => void;
	/** The items in the queue, the next due first. */
	list(options?: QueueListOptions): Promise<QueueItem[]>;
	get(id: string): Promise<QueueItem | undefined>;
	/** Makes an item due now, and wakes the worker. False when there is no such item. */
	retryNow(id: string): Promise<boolean>;
	/** Drops an item, its message and its recipients, with no DSN; the item as it stood, or `undefined`. */
	cancel(id: string): Promise<QueueItem | undefined>;
}

/**
 * Creates the queue over a store. Nothing is delivered until `start()`,
 * or `deliverDue()` by hand. Several queues — in one process or several —
 * may share a store: each claims items under its own `owner`.
 */
export function createQueue(options: QueueOptions): Queue {
	const settings = settingsOf(options);
	const store = options.store;
	const events = new Events();
	const worker = new Worker({ settings, store, events });
	const { limits } = settings;
	return {
		owner: settings.owner,
		async enqueue(message, envelope) {
			const { from, to } = checkEnvelope(envelope, limits.maxRecipients);
			const bytes = await readMessage(message, limits.maxMessageSize);
			const item = await store.add(
				{ from, to, message: bytes, createdAt: settings.now() },
				limits.maxItems === undefined ? {} : { maxItems: limits.maxItems },
			);
			worker.wake();
			return item;
		},
		deliverDue: () => worker.deliverDue(),
		start: () => worker.start(),
		stop: () => worker.stop(),
		on: (event, listener) => events.on(event, listener),
		list: (listOptions) => store.list(listOptions),
		get: (id) => store.get(id),
		async retryNow(id) {
			const moved = await store.reschedule(id, settings.now());
			if (moved) worker.wake();
			return moved;
		},
		cancel: (id) => store.cancel(id),
	};
}
