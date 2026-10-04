import type { Mailbox, MailStore } from '@bumail/store';
import type { Args } from '../api/args';
import { isUnread } from '../email/keywords';

export const MAILBOX_PROPERTIES = [
	'id',
	'name',
	'parentId',
	'role',
	'sortOrder',
	'totalEmails',
	'unreadEmails',
	'totalThreads',
	'unreadThreads',
	'myRights',
	'isSubscribed',
] as const;

/**
 * What the account may do in a mailbox (RFC 8621 §2): everything but
 * submit, since there is no EmailSubmission yet, and no ACL in the store.
 */
export const MY_RIGHTS = {
	mayReadItems: true,
	mayAddItems: true,
	mayRemoveItems: true,
	maySetSeen: true,
	maySetKeywords: true,
	mayCreateChild: true,
	mayRename: true,
	mayDelete: true,
	maySubmit: false,
} as const;

/**
 * A mailbox's counts that the store's do not give as RFC 8621 §2 asks: its
 * unread emails, and its threads with those unread among them.
 */
export interface MailboxCounts {
	readonly unreadEmails: number;
	readonly totalThreads: number;
	readonly unreadThreads: number;
}

/**
 * Counts a mailbox's unread emails and its threads in one pass over its
 * messages: the store keeps no thread counts, and its unseen count is IMAP's.
 * A thread is unread when one of its emails in this mailbox is (the RFC's
 * simplest rule): an unread email of the thread in another mailbox does not
 * count here.
 */
export async function mailboxCounts(
	store: MailStore,
	accountId: string,
	mailboxId: string,
): Promise<MailboxCounts> {
	const threads = new Map<string, boolean>();
	let unreadEmails = 0;
	for (const { message } of await store.listMessages(accountId, mailboxId)) {
		const unread = isUnread(message.flags);
		if (unread) unreadEmails++;
		threads.set(
			message.threadId,
			(threads.get(message.threadId) ?? false) || unread,
		);
	}
	let unreadThreads = 0;
	for (const value of threads.values()) if (value) unreadThreads++;
	return { unreadEmails, totalThreads: threads.size, unreadThreads };
}

/** A store mailbox as a JMAP Mailbox, with the properties asked for. */
export function mailboxObject(
	mailbox: Mailbox,
	properties: readonly string[],
	counts: MailboxCounts | undefined,
): Args {
	const all: Args = {
		id: mailbox.id,
		name: mailbox.name,
		parentId: mailbox.parentId ?? null,
		role: mailbox.role ?? null,
		sortOrder: 0,
		totalEmails: mailbox.messages,
		unreadEmails: counts?.unreadEmails ?? mailbox.unseen,
		totalThreads: counts?.totalThreads ?? mailbox.messages,
		unreadThreads: counts?.unreadThreads ?? mailbox.unseen,
		myRights: MY_RIGHTS,
		isSubscribed: mailbox.isSubscribed,
	};
	const object: Args = { id: mailbox.id };
	for (const property of properties) object[property] = all[property];
	return object;
}
