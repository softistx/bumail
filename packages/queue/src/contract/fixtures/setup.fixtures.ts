import { expect } from 'bun:test';
import type { QueueStore } from '../queue-store';
import type { NewQueueItem } from '../types';

/** A new store, empty. */
export type CreateStore = () => Promise<QueueStore> | QueueStore;

/**
 * Another handle on the same queue as `store`: a second connection to the
 * same database, as a second process would open. A store with nothing to
 * share answers with `store` itself.
 */
export type ShareStore = (store: QueueStore) => QueueStore;

export interface StoreFactories {
	readonly create: CreateStore;
	readonly share: ShareStore;
}

export const bytes = (text: string) => new TextEncoder().encode(text);

export const T0 = Date.UTC(2026, 9, 1, 12);
export const MINUTE = 60_000;

/** A new item from mary to two recipients, created at `T0` unless told otherwise. */
export function entry(overrides: Partial<NewQueueItem> = {}): NewQueueItem {
	return {
		from: 'mary@example.net',
		to: ['joe@example.com', 'ann@example.org'],
		message: bytes('Subject: Hi\r\n\r\nHello\r\n'),
		createdAt: T0,
		...overrides,
	};
}

/** Expects a promise to reject with a QueueError of this code. */
export async function rejects(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ name: 'QueueError', code });
}
