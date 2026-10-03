import { StoreError } from '../errors';
import { hasControl } from './flags';
import type { MailboxRole } from './types';

/** The roles a mailbox may have. */
export const MAILBOX_ROLES: readonly MailboxRole[] = [
	'inbox',
	'all',
	'archive',
	'drafts',
	'flagged',
	'important',
	'junk',
	'sent',
	'trash',
];

/** Whether a string is a role, narrowing it: for a role read from outside. */
export function isMailboxRole(value: unknown): value is MailboxRole {
	return (MAILBOX_ROLES as readonly unknown[]).includes(value);
}

/**
 * A mailbox name as stored: trimmed, and `INBOX` at the top whatever its
 * case (RFC 9051 §5.1). It may not hold `/`: the hierarchy is `parentId`,
 * so the IMAP layer can use `/` as its delimiter.
 */
export function normalizeMailboxName(
	name: string,
	parentId: string | undefined,
): string {
	const clean = typeof name === 'string' ? name.trim() : '';
	if (clean === '' || clean.length > 255 || hasControl(clean)) {
		throw new StoreError('INVALID', `"${name}" is not a mailbox name`);
	}
	if (clean.includes('/')) {
		throw new StoreError(
			'INVALID',
			`A mailbox name cannot hold "/": "${name}"; give a parentId instead`,
		);
	}
	return parentId === undefined && clean.toLowerCase() === 'inbox'
		? 'INBOX'
		: clean;
}

export function checkRole(role: MailboxRole | undefined): void {
	if (role !== undefined && !isMailboxRole(role)) {
		throw new StoreError('INVALID', `"${role}" is not a mailbox role`);
	}
}

/**
 * Refuses anything that is not a role, `undefined` included: for a lookup
 * by role, where no role is not a role, unlike `checkRole`'s optional field.
 */
export function checkRequiredRole(role: unknown): asserts role is MailboxRole {
	if (!isMailboxRole(role)) {
		throw new StoreError('INVALID', `"${String(role)}" is not a mailbox role`);
	}
}

/** Refuses a parent that is the mailbox itself or one of its descendants. */
export function checkNoCycle(
	self: string,
	parentId: string | undefined,
	parentOf: (id: string) => string | undefined,
): void {
	for (let at = parentId; at !== undefined; at = parentOf(at)) {
		if (at === self) {
			throw new StoreError('INVALID', 'A mailbox cannot be inside itself');
		}
	}
}
