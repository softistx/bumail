import { StoreError } from '../errors';
import type { MailboxRole } from './types';

// The errors every store raises when what it is asked would break what it
// holds: built here once, so each store says the same thing.

export function accountExists(login: string): StoreError {
	return new StoreError(
		'ALREADY_EXISTS',
		`An account "${login}" already exists`,
	);
}

export function mailboxExists(name: string): StoreError {
	return new StoreError(
		'ALREADY_EXISTS',
		`A mailbox "${name}" already exists there`,
	);
}

export function roleTaken(role: MailboxRole): StoreError {
	return new StoreError(
		'ALREADY_EXISTS',
		`The account already has a mailbox with the role ${role}`,
	);
}

export function hasChildren(): StoreError {
	return new StoreError('INVALID', 'A mailbox with children cannot be deleted');
}

export function notEmpty(): StoreError {
	return new StoreError(
		'INVALID',
		'Only an empty mailbox can be deleted without removeMessages',
	);
}
