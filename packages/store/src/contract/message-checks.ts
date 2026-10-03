import { StoreError } from '../errors';
import { checkThreadId } from './checks';
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
