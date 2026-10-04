import type { Directory } from '../../directory/directory';
import { provisionAccount } from '../../store/accounts';
import { type Spooled, spooledStream } from '../spool';
import type { MxContext } from './index';

/** The users a message for `to` goes to, each once: aliases expanded. */
export function usersOf(directory: Directory, to: readonly string[]): string[] {
	const users = new Set<string>();
	for (const address of to) {
		for (const user of directory.resolve(address) ?? []) users.add(user);
	}
	return [...users];
}

/** Adds the message to `user`'s INBOX, or Junk, its account and mailboxes created if need be. */
export async function deliver(
	ctx: MxContext,
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
