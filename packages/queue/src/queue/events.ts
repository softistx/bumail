import type { Diagnostic } from '../contract/types';

/** One recipient's outcome. */
export interface RecipientEvent {
	/** The item's id. */
	readonly id: string;
	readonly from: string;
	readonly recipient: string;
	/** What the other side said, or why nobody said anything. */
	readonly reply?: Diagnostic;
	/** The attempts made so far, this one included. */
	readonly attempts: number;
}

export interface DeferredEvent extends RecipientEvent {
	/** When the recipient is tried again, in milliseconds since the epoch. */
	readonly nextAttemptAt: number;
}

/** A DSN, enqueued back to the sender. */
export interface DsnEvent {
	readonly kind: 'delayed' | 'failed';
	/** The DSN's own item id. */
	readonly id: string;
	/** The id of the item it reports on. */
	readonly of: string;
	/** The original's sender, to whom it goes. */
	readonly to: string;
	readonly recipients: readonly string[];
}

/** A failure of the queue itself: the store, a DSN that could not be enqueued, a lease lost. */
export interface QueueErrorEvent {
	readonly error: unknown;
	/** The item it happened to, if any. */
	readonly id?: string;
}

export interface QueueEvents {
	delivered: RecipientEvent;
	deferred: DeferredEvent;
	failed: RecipientEvent;
	dsn: DsnEvent;
	error: QueueErrorEvent;
}

export type QueueListener<E extends keyof QueueEvents> = (
	event: QueueEvents[E],
) => void;

/** Listeners by event. One that throws is ignored: it never stops a delivery. */
export class Events {
	readonly #listeners = new Map<keyof QueueEvents, Set<(e: never) => void>>();

	on<E extends keyof QueueEvents>(
		event: E,
		listener: QueueListener<E>,
	): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener as (e: never) => void);
		return () => {
			set.delete(listener as (e: never) => void);
		};
	}

	emit<E extends keyof QueueEvents>(event: E, payload: QueueEvents[E]): void {
		for (const listener of this.#listeners.get(event) ?? []) {
			try {
				(listener as QueueListener<E>)(payload);
			} catch {
				// A listener's failure is its own.
			}
		}
	}
}
