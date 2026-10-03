import type { Message } from '@bumail/store';
import {
	type Args,
	accountOf,
	idsOf,
	onlyKnown,
	propertiesOf,
} from '../api/args';
import type { CallContext } from '../api/context';
import { MethodError } from '../api/errors';
import { stateOf } from '../api/state';

const PROPERTIES = ['id', 'emailIds'];

/**
 * Thread/get (RFC 8621 §3.1). The store keeps a thread id per message but
 * no index of them, so the account's emails are read, at most
 * `maxQueryScan` of them. Messages are their own thread unless the app
 * gave a `threadId` when adding them.
 */
export async function threadGet(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, ['accountId', 'ids', 'properties']);
	const accountId = accountOf(args, ctx);
	const ids = idsOf(args, 'ids', ctx, ctx.settings.limits.maxObjectsInGet);
	const properties = propertiesOf(
		args,
		'properties',
		(p) => PROPERTIES.includes(p),
		PROPERTIES,
	);
	if (ids === null)
		throw new MethodError('requestTooLarge', 'Thread/get needs ids');
	const state = await stateOf(ctx.store, accountId);
	const max = ctx.settings.limits.maxQueryScan;
	const page = await ctx.store.listAccountMessages(accountId, { limit: max });
	if (page.total > max) {
		throw new MethodError(
			'tooLarge',
			`The account has more than ${max} emails: the store has no thread index yet`,
		);
	}
	const threads = new Map<string, Message[]>();
	for (const message of page.messages) {
		const thread = threads.get(message.threadId) ?? [];
		thread.push(message);
		threads.set(message.threadId, thread);
	}
	const list: Args[] = [];
	const notFound: string[] = [];
	for (const id of new Set(ids)) {
		const thread = threads.get(id);
		if (thread === undefined) {
			notFound.push(id);
			continue;
		}
		thread.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
		const object: Args = { id };
		if (properties.includes('emailIds'))
			object['emailIds'] = thread.map((message) => message.id);
		list.push(object);
	}
	return { accountId, state, list, notFound };
}
