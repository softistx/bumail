import { type Args, accountOf, onlyKnown } from '../api/args';
import type { CallContext } from '../api/context';
import { setError } from '../api/errors';
import { SetResult, setPlanOf, storeSetError } from '../api/set';
import { checkIfInState, stateOf } from '../api/state';
import { importEmail } from './import';
import { emailChangeOf, flagChangeOf, mailboxesAfter } from './patch';

async function create(
	ctx: CallContext,
	result: SetResult,
	creationId: string,
	object: Args,
) {
	const created = await importEmail(object, ctx);
	if ('type' in created) {
		result.notCreated[creationId] = created as never;
		return;
	}
	result.created[creationId] = created;
	ctx.created.set(creationId, created['id'] as string);
}

/** Moves a message to exactly `target`: linked into the new mailboxes first, so it is never in none. */
async function moveTo(
	ctx: CallContext,
	id: string,
	current: readonly string[],
	target: Set<string>,
) {
	for (const mailboxId of target) {
		if (!current.includes(mailboxId))
			await ctx.store.linkMessages(ctx.accountId, [id], mailboxId);
	}
	for (const mailboxId of current) {
		if (!target.has(mailboxId))
			await ctx.store.removeMessages(ctx.accountId, [id], mailboxId);
	}
}

async function update(
	ctx: CallContext,
	result: SetResult,
	id: string,
	patch: Args,
	mailboxes: ReadonlySet<string>,
) {
	const message = await ctx.store.getMessage(ctx.accountId, id);
	if (message === undefined) {
		result.notUpdated[id] = setError('notFound');
		return;
	}
	const change = emailChangeOf(patch, ctx);
	if ('type' in change) {
		result.notUpdated[id] = change as never;
		return;
	}
	const target =
		change.mailboxIds && mailboxesAfter(change.mailboxIds, message);
	if (
		target !== undefined &&
		(target.size === 0 || [...target].some((one) => !mailboxes.has(one)))
	) {
		result.notUpdated[id] = setError(
			'invalidProperties',
			'mailboxIds names at least one mailbox, each of the account',
			['mailboxIds'],
		);
		return;
	}
	try {
		if (change.keywords)
			await ctx.store.setFlags(
				ctx.accountId,
				[id],
				flagChangeOf(change.keywords, message),
			);
		if (target)
			await moveTo(
				ctx,
				id,
				message.mailboxes.map(({ mailboxId }) => mailboxId),
				target,
			);
		result.updated[id] = null;
	} catch (error) {
		result.notUpdated[id] = storeSetError(
			error,
			change.mailboxIds ? 'mailboxIds' : 'keywords',
		);
	}
}

/**
 * Email/set (RFC 8621 §4.6): updates keywords and mailboxIds, whole or
 * patched, and destroys. A create takes an uploaded `blobId`, as
 * Email/import does; one built from properties is not supported yet.
 */
export async function emailSet(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, ['accountId', 'ifInState', 'create', 'update', 'destroy']);
	const accountId = accountOf(args, ctx);
	const plan = setPlanOf(args, ctx, ctx.settings.limits.maxObjectsInSet);
	const oldState = await checkIfInState(
		ctx.store,
		accountId,
		args['ifInState'],
	);
	const result = new SetResult();
	for (const [creationId, object] of plan.create)
		await create(ctx, result, creationId, object);
	if (plan.update.length > 0) {
		const mailboxes = new Set(
			(await ctx.store.listMailboxes(accountId)).map(({ id }) => id),
		);
		for (const [id, patch] of plan.update)
			await update(ctx, result, id, patch, mailboxes);
	}
	if (plan.destroy.length > 0) {
		const { expunged, notFound } = await ctx.store.destroyMessages(
			accountId,
			plan.destroy,
		);
		for (const id of new Set(expunged.map(({ messageId }) => messageId)))
			result.destroyed.push(id);
		for (const id of notFound) result.notDestroyed[id] = setError('notFound');
	}
	return result.toArgs(
		accountId,
		oldState,
		await stateOf(ctx.store, accountId),
	);
}
