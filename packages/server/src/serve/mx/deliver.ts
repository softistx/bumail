import type { MailStore } from '@bumail/store';
import { provisionAccount } from '../../store/accounts';
import { type Spooled, spooledStream } from '../spool';

/** Where a delivery goes, and who is told of it. */
export interface DeliveryContext {
	readonly store: MailStore;
	/** Told of each account a message was added to: IMAP's IDLE looks at once. */
	onDelivered(accountId: string): void;
}

/** Adds the message to `user`'s INBOX, or Junk, its account and mailboxes created if need be. */
export async function deliver(
	ctx: DeliveryContext,
	user: string,
	junk: boolean,
	prefix: Uint8Array,
	spooled: Spooled,
): Promise<void> {
	const { store } = ctx;
	const account = await provisionAccount(store, user);
	const mailbox =
		(junk ? await store.findMailbox(account.id, 'junk') : undefined) ??
		(await store.findMailbox(account.id, 'inbox'));
	if (mailbox === undefined) {
		throw new Error(`the account of ${user} has no INBOX`);
	}
	await store.addMessage(account.id, mailbox.id, {
		content: spooledStream(prefix, spooled.stream(spooled.bodyStart)),
	});
	ctx.onDelivered(account.id);
}
