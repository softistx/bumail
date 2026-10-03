import { StoreError } from '../errors';
import type { MailboxRename } from './types';

/** RFC 9051 §2.3.1.1: a UID is a 32-bit number. */
export const MAX_UID = 2 ** 32 - 1;

/** Refuses a count given in that is not an integer of at least `least`. */
export function checkCount(
	name: string,
	value: number | undefined,
	least = 0,
): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < least)) {
		throw new StoreError(
			'INVALID',
			`${name} must be an integer of at least ${least}, not ${value}`,
		);
	}
}

/** A thread id given in: a non-empty string of printable characters. */
export function checkThreadId(threadId: unknown): void {
	if (
		threadId !== undefined &&
		(typeof threadId !== 'string' ||
			threadId === '' ||
			threadId.length > 255 ||
			/[^\x21-\x7e]/.test(threadId))
	) {
		throw new StoreError('INVALID', `"${threadId}" is not a thread id`);
	}
}

/** The message ids given in, each once, in their first order; refuses anything but strings. */
export function uniqueIds(ids: readonly string[]): string[] {
	if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
		throw new StoreError('INVALID', 'ids must be an array of strings');
	}
	return [...new Set(ids)];
}

/** Refuses a mailbox that has no room for `count` more UIDs. */
export function checkUids(
	mailbox: { readonly name: string; readonly uidNext: number },
	count: number,
): void {
	if (mailbox.uidNext + count - 1 > MAX_UID) {
		throw new StoreError(
			'INVALID',
			`Mailbox "${mailbox.name}" has run out of UIDs`,
		);
	}
}

/** The tombstones to keep: `Infinity` by default; refuses anything but a count. */
export function checkMaxTombstones(value: number | undefined): number {
	const max = value ?? Number.POSITIVE_INFINITY;
	if (
		!(
			max === Number.POSITIVE_INFINITY ||
			(Number.isSafeInteger(max) && max >= 0)
		)
	) {
		throw new StoreError(
			'INVALID',
			`maxTombstones must be an integer of at least 0, not ${max}`,
		);
	}
	return max;
}

/** A login as stored: trimmed, and not empty. */
export function normalizeLogin(name: string): string {
	const login = typeof name === 'string' ? name.trim() : '';
	if (login === '') throw new StoreError('INVALID', 'An account needs a name');
	return login;
}

/** A login as looked up: trimmed and lower-cased, compared case-insensitively. */
export function loginKey(name: string): string {
	return String(name).trim().toLowerCase();
}

/** Where a rename puts a mailbox: a field left out keeps its value. */
export function renameTarget(
	current: { readonly name: string; readonly parentId?: string },
	change: MailboxRename,
): { name: string; parentId: string | undefined } {
	if (typeof change !== 'object' || change === null) {
		throw new StoreError('INVALID', 'A rename is an object');
	}
	const { name, parentId } = change;
	if (name === undefined && parentId === undefined) {
		throw new StoreError(
			'INVALID',
			'A rename gives a name, a parentId or both',
		);
	}
	if (
		parentId !== undefined &&
		parentId !== null &&
		typeof parentId !== 'string'
	) {
		throw new StoreError('INVALID', 'parentId is a mailbox id or null');
	}
	return {
		name: name ?? current.name,
		parentId:
			parentId === undefined ? current.parentId : (parentId ?? undefined),
	};
}
