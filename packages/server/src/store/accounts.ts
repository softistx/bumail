import { type Account, type MailStore, StoreError } from '@bumail/store';

/** The mailboxes every account starts with, by name and role. */
export const MAILBOXES = [
	['INBOX', 'inbox'],
	['Sent', 'sent'],
	['Drafts', 'drafts'],
	['Archive', 'archive'],
	['Junk', 'junk'],
	['Trash', 'trash'],
] as const;

function exists(error: unknown): boolean {
	return error instanceof StoreError && error.code === 'ALREADY_EXISTS';
}

/**
 * The store's account for the user at `address` — the account whose
 * login is the address — created with its mailboxes if need be: `INBOX`,
 * `Sent`, `Drafts`, `Archive`, `Junk` and `Trash`, each with its role.
 * Safe to call again, and at once from two places: what is there already
 * is kept, a mailbox renamed by its user included, and a missing role is
 * added back. An account kept from a user removed earlier is the one
 * found, with its mail.
 */
export async function provisionAccount(
	store: MailStore,
	address: string,
): Promise<Account> {
	let account = await store.findAccount(address);
	if (account === undefined) {
		try {
			account = await store.createAccount(address);
		} catch (error) {
			if (!exists(error)) throw error;
			account = await store.findAccount(address);
			if (account === undefined) throw error;
		}
	}
	const roles = new Set(
		(await store.listMailboxes(account.id)).map((mailbox) => mailbox.role),
	);
	for (const [name, role] of MAILBOXES) {
		if (roles.has(role)) continue;
		try {
			await store.createMailbox(account.id, { name, role });
		} catch (error) {
			if (!exists(error)) throw error;
		}
	}
	return account;
}

/** Deletes the store's account for `address`, its mailboxes and its mail; `false` when there was none. */
export async function purgeAccount(
	store: MailStore,
	address: string,
): Promise<boolean> {
	const account = await store.findAccount(address);
	if (account === undefined) return false;
	try {
		await store.deleteAccount(account.id);
	} catch (error) {
		if (error instanceof StoreError && error.code === 'NOT_FOUND') return false;
		throw error;
	}
	return true;
}
