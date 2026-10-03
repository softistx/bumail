/**
 * The demo's one account and its delivery: the store, the user table, and
 * putting a message in a local user's INBOX, then waking IDLE.
 */
import type { MailStore } from '@bumail/store';
import { ADDRESS, DOMAIN, USER } from './config';

export interface Mailboxes {
	readonly store: MailStore;
	/** The account id for a login name (`alice` or `alice@example.test`), or `undefined`. */
	login(username: string, password: string): Promise<string | undefined>;
	/** The account id of a local address, or `undefined` when nobody has it. */
	accountOf(address: string): Promise<string | undefined>;
	/** Files the message in the account's INBOX and wakes its IDLE sessions. */
	deliver(accountId: string, content: Uint8Array): Promise<void>;
	/** Called after each delivery, with the account: the IMAP servers' `notify`. */
	onDelivered(listener: (accountId: string) => void): void;
}

const ROLES = [
	['INBOX', 'inbox'],
	['Sent', 'sent'],
	['Drafts', 'drafts'],
	['Archive', 'archive'],
	['Junk', 'junk'],
	['Trash', 'trash'],
] as const;

export async function openMailboxes(
	store: MailStore,
	password: string,
): Promise<Mailboxes> {
	const account =
		(await store.findAccount(ADDRESS)) ?? (await store.createAccount(ADDRESS));
	const existing = await store.listMailboxes(account.id);
	for (const [name, role] of ROLES) {
		if (!existing.some((mailbox) => mailbox.role === role)) {
			await store.createMailbox(account.id, { name, role });
		}
	}
	const hash = await Bun.password.hash(password);
	const listeners: ((accountId: string) => void)[] = [];

	return {
		store,
		async login(username, given) {
			const name = username.toLowerCase();
			if (name !== USER && name !== ADDRESS) return undefined;
			return (await Bun.password.verify(given, hash)) ? account.id : undefined;
		},
		async accountOf(address) {
			const at = address.lastIndexOf('@');
			const domain = address.slice(at + 1).toLowerCase();
			if (domain !== DOMAIN) return undefined;
			return (await store.findAccount(address.toLowerCase()))?.id;
		},
		async deliver(accountId, content) {
			const inbox = await store.findMailbox(accountId, 'inbox');
			if (inbox === undefined) throw new Error(`${accountId} has no INBOX`);
			await store.addMessage(accountId, inbox.id, { content });
			for (const listener of listeners) listener(accountId);
		},
		onDelivered(listener) {
			listeners.push(listener);
		},
	};
}
