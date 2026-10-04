import {
	type Args,
	accountOf,
	idsOf,
	onlyKnown,
	propertiesOf,
} from '../api/args';
import { changes } from '../api/changes';
import type { CallContext } from '../api/context';
import { MethodError } from '../api/errors';
import { stateOf } from '../api/state';
import {
	MAILBOX_PROPERTIES,
	type MailboxCounts,
	mailboxCounts,
	mailboxObject,
} from './properties';

const known = (property: string) =>
	(MAILBOX_PROPERTIES as readonly string[]).includes(property);

/** Mailbox/get (RFC 8621 §2.1). */
export async function mailboxGet(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, ['accountId', 'ids', 'properties']);
	const accountId = accountOf(args, ctx);
	const max = ctx.settings.limits.maxObjectsInGet;
	const ids = idsOf(args, 'ids', ctx, max);
	const properties = propertiesOf(
		args,
		'properties',
		known,
		MAILBOX_PROPERTIES,
	);
	const state = await stateOf(ctx.store, accountId);
	const mailboxes = await ctx.store.listMailboxes(accountId);
	if (ids === null && mailboxes.length > max) {
		throw new MethodError(
			'requestTooLarge',
			`The account has more than ${max} mailboxes: ask for ids`,
		);
	}
	const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
	const wanted = ids ?? mailboxes.map((mailbox) => mailbox.id);
	// The store's unseen count is IMAP's (`\Seen` only), and it keeps no
	// thread counts: these three are counted here, in one pass per mailbox.
	const count =
		properties.includes('unreadEmails') ||
		properties.includes('totalThreads') ||
		properties.includes('unreadThreads');
	const list: Args[] = [];
	const notFound: string[] = [];
	let left = ctx.settings.limits.maxQueryScan;
	for (const id of new Set(wanted)) {
		const mailbox = byId.get(id);
		if (mailbox === undefined) {
			notFound.push(id);
			continue;
		}
		// Past the scan budget, the store's counts stand in.
		let counts: MailboxCounts | undefined;
		if (count && mailbox.messages <= left) {
			left -= mailbox.messages;
			counts = await mailboxCounts(ctx.store, accountId, id);
		}
		list.push(mailboxObject(mailbox, properties, counts));
	}
	return { accountId, state, list, notFound };
}

/** Mailbox/changes (RFC 8621 §2.2): which properties changed is not known, so `updatedProperties` is null. */
export function mailboxChanges(args: Args, ctx: CallContext): Promise<Args> {
	return changes(
		args,
		ctx,
		(since, limit) =>
			ctx.store.mailboxChanges(
				ctx.accountId,
				since,
				limit === undefined ? {} : { limit },
			),
		{ updatedProperties: null },
	);
}
