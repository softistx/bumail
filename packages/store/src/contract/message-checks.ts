import { StoreError } from '../errors';
import { checkThreadId, uniqueIds } from './checks';
import { normalizeFlags } from './flags';
import type { NewMessage } from './types';

/** A new message as every store checks it, before its content is read. */
export interface CheckedMessage {
	/** Normalised, without duplicates, sorted. */
	readonly flags: string[];
	/** In milliseconds since the epoch. */
	readonly receivedAt: number;
	readonly threadId: string | undefined;
}

/**
 * Checks a new message, in the order every store checks it, so the same
 * error wins: an object, its flags, its date, then its thread.
 */
export function checkNewMessage(input: NewMessage): CheckedMessage {
	if (typeof input !== 'object' || input === null) {
		throw new StoreError('INVALID', 'A new message is an object');
	}
	const flags = normalizeFlags(input.flags ?? []);
	if (input.receivedAt !== undefined && !(input.receivedAt instanceof Date)) {
		throw new StoreError('INVALID', 'receivedAt is not a valid date');
	}
	const receivedAt = input.receivedAt?.getTime() ?? Date.now();
	if (!Number.isFinite(receivedAt)) {
		throw new StoreError('INVALID', 'receivedAt is not a valid date');
	}
	const threadId = input.threadId;
	checkThreadId(threadId);
	return { flags, receivedAt, threadId };
}

/**
 * The messages for these ids, each once, in their first order, and the ids
 * that name none: `find` answers `undefined` for no such message, another
 * account's, or one the call does not act on.
 */
export function partitionIds<T>(
	ids: readonly string[],
	find: (id: string) => T | undefined,
): { found: T[]; notFound: string[] } {
	const found: T[] = [];
	const notFound: string[] = [];
	for (const id of uniqueIds(ids)) {
		const thing = find(id);
		if (thing === undefined) notFound.push(id);
		else found.push(thing);
	}
	return { found, notFound };
}
