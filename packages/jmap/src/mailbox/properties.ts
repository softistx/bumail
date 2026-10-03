import type { Mailbox, MailStore } from '@bumail/store';
import type { Args } from '../api/args';

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

/** A mailbox's threads, and those with an unread email in it. */
export interface ThreadCounts {
	readonly total: number;
	readonly unread: number;
}

/** Counts a mailbox's threads by listing its messages: the store keeps no thread counts. */
export async function threadCounts(
	store: MailStore,
	accountId: string,
	mailboxId: string,
): Promise<ThreadCounts> {
	const threads = new Map<string, boolean>();
	for (const { message } of await store.listMessages(accountId, mailboxId)) {
		const unread = !message.flags.includes('\\Seen');
		threads.set(
			message.threadId,
			(threads.get(message.threadId) ?? false) || unread,
		);
	}
	let unread = 0;
	for (const value of threads.values()) if (value) unread++;
	return { total: threads.size, unread };
}

/** A store mailbox as a JMAP Mailbox, with the properties asked for. */
export function mailboxObject(
	mailbox: Mailbox,
	properties: readonly string[],
	threads: ThreadCounts | undefined,
): Args {
	const all: Args = {
		id: mailbox.id,
		name: mailbox.name,
		parentId: mailbox.parentId ?? null,
		role: mailbox.role ?? null,
		sortOrder: 0,
		totalEmails: mailbox.messages,
		unreadEmails: mailbox.unseen,
		totalThreads: threads?.total ?? mailbox.messages,
		unreadThreads: threads?.unread ?? mailbox.unseen,
		myRights: MY_RIGHTS,
		isSubscribed: mailbox.isSubscribed,
	};
	const object: Args = { id: mailbox.id };
	for (const property of properties) object[property] = all[property];
	return object;
}
