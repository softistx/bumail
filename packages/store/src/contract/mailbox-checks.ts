import { StoreError } from '../errors';
import { mailboxExists, roleTaken } from './conflicts';
import { checkNoCycle, checkRole, normalizeMailboxName } from './mailbox-name';
import type { MailboxRole, NewMailbox } from './types';

/** What a store answers about its mailboxes, for the checks every store runs alike. */
export interface MailboxLookups {
	/** Refuses a parent that is not the account's mailbox. */
	checkParent(id: string): void;
	/** The parent of a mailbox, for walking up the hierarchy. */
	parentOf(id: string): string | undefined;
	/** Whether a mailbox other than `self` has this name under this parent. */
	isTaken(
		name: string,
		parentId: string | undefined,
		self: string | undefined,
	): boolean;
	/** Whether the account already has a mailbox with this role. */
	hasRole(role: MailboxRole): boolean;
}

/** Refuses a subscription that is not a boolean. */
export function checkSubscribed(subscribed: unknown): void {
	if (typeof subscribed !== 'boolean') {
		throw new StoreError('INVALID', 'isSubscribed is true or false');
	}
}

/**
 * Checks a name and a parent for a mailbox, `self` when it is a rename:
 * the name as stored, under a parent of the account's that is not the
 * mailbox itself, and taken by no other mailbox there.
 */
export function placeMailbox(
	lookups: MailboxLookups,
	name: string,
	parentId: string | undefined,
	self?: string,
): string {
	const clean = normalizeMailboxName(name, parentId);
	if (parentId !== undefined) {
		lookups.checkParent(parentId);
		if (self !== undefined) {
			checkNoCycle(self, parentId, (id) => lookups.parentOf(id));
		}
	}
	if (lookups.isTaken(clean, parentId, self)) throw mailboxExists(clean);
	return clean;
}

/**
 * Checks a new mailbox, in the order every store checks it, so the same
 * error wins: an object, its place, its role, its subscription, then a
 * role the account already gives. Returns its name as stored.
 */
export function checkNewMailbox(
	lookups: MailboxLookups,
	input: NewMailbox,
): string {
	if (typeof input !== 'object' || input === null) {
		throw new StoreError('INVALID', 'A new mailbox is an object');
	}
	const name = placeMailbox(lookups, input.name, input.parentId);
	checkRole(input.role);
	if (input.isSubscribed !== undefined) checkSubscribed(input.isSubscribed);
	if (input.role !== undefined && lookups.hasRole(input.role)) {
		throw roleTaken(input.role);
	}
	return name;
}
