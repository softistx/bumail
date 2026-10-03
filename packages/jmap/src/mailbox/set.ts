import {
	isMailboxRole,
	type MailboxRename,
	type MailStore,
	type NewMailbox,
	StoreError,
} from '@bumail/store';
import { type Args, accountOf, boolOf, idOf, onlyKnown } from '../api/args';
import type { CallContext } from '../api/context';
import { type SetError, setError } from '../api/errors';
import { SetResult, setPlanOf, storeSetError } from '../api/set';
import { checkIfInState, stateOf } from '../api/state';
import { MY_RIGHTS } from './properties';

/** A property a client may not set, or may set only to what it is. */
const invalid = (property: string, description: string): SetError =>
	setError('invalidProperties', description, [property]);

/** The `parentId` given: `null`, an id, or a `#creationId`; `undefined` when it names nothing. */
function parentOf(value: unknown, ctx: CallContext): string | null | undefined {
	if (value === null) return null;
	return idOf(value, ctx);
}

/** A create's properties as a NewMailbox, or the SetError that refuses it. */
function newMailboxOf(object: Args, ctx: CallContext): NewMailbox | SetError {
	for (const [key, value] of Object.entries(object)) {
		if (key === 'sortOrder' && value === 0) continue;
		if (!['name', 'parentId', 'role', 'isSubscribed'].includes(key)) {
			return invalid(
				key,
				key === 'sortOrder'
					? 'sortOrder can only be 0'
					: 'This property cannot be set',
			);
		}
	}
	const { name, parentId, role, isSubscribed } = object;
	if (typeof name !== 'string') return invalid('name', 'name is required');
	const parent = parentId === undefined ? null : parentOf(parentId, ctx);
	if (parent === undefined)
		return invalid('parentId', 'parentId names no mailbox');
	if (
		role !== undefined &&
		role !== null &&
		(typeof role !== 'string' || !isMailboxRole(role))
	) {
		return invalid('role', 'role is not one this server knows');
	}
	if (isSubscribed !== undefined && typeof isSubscribed !== 'boolean') {
		return invalid('isSubscribed', 'isSubscribed is a boolean');
	}
	return {
		name,
		...(parent === null ? {} : { parentId: parent }),
		...(typeof role === 'string' && isMailboxRole(role) ? { role } : {}),
		...(isSubscribed === undefined ? {} : { isSubscribed }),
	};
}

async function create(
	ctx: CallContext,
	result: SetResult,
	creationId: string,
	object: Args,
) {
	const mailbox = newMailboxOf(object, ctx);
	if ('type' in mailbox) {
		result.notCreated[creationId] = mailbox;
		return;
	}
	try {
		const made = await ctx.store.createMailbox(ctx.accountId, mailbox);
		ctx.created.set(creationId, made.id);
		result.created[creationId] = {
			id: made.id,
			role: made.role ?? null,
			sortOrder: 0,
			isSubscribed: made.isSubscribed,
			totalEmails: 0,
			unreadEmails: 0,
			totalThreads: 0,
			unreadThreads: 0,
			myRights: MY_RIGHTS,
		};
	} catch (error) {
		result.notCreated[creationId] = storeSetError(
			error,
			error instanceof StoreError && error.code === 'NOT_FOUND'
				? 'parentId'
				: 'name',
		);
	}
}

/** An update's patch as a rename and a subscription, or the SetError that refuses it. */
function changeOf(
	patch: Args,
	ctx: CallContext,
	current: { readonly role?: string },
): { rename?: MailboxRename; subscribed?: boolean } | SetError {
	let rename: { name?: string; parentId?: string | null } | undefined;
	let subscribed: boolean | undefined;
	for (const [key, value] of Object.entries(patch)) {
		if (key === 'name') {
			if (typeof value !== 'string') return invalid('name', 'name is a string');
			rename = { ...rename, name: value };
		} else if (key === 'parentId') {
			const parent = parentOf(value, ctx);
			if (parent === undefined)
				return invalid('parentId', 'parentId names no mailbox');
			rename = { ...rename, parentId: parent };
		} else if (key === 'isSubscribed' && typeof value === 'boolean') {
			subscribed = value;
		} else if (key === 'sortOrder' && value === 0) {
			// The only sortOrder the store keeps.
		} else if (key === 'role' && value === (current.role ?? null)) {
			// Unchanged: the store cannot change a role.
		} else {
			return invalid(key, 'This property cannot be changed');
		}
	}
	return {
		...(rename === undefined ? {} : { rename: rename as MailboxRename }),
		...(subscribed === undefined ? {} : { subscribed }),
	};
}

async function update(
	ctx: CallContext,
	result: SetResult,
	id: string,
	patch: Args,
) {
	const current = await ctx.store.getMailbox(ctx.accountId, id);
	if (current === undefined) {
		result.notUpdated[id] = setError('notFound');
		return;
	}
	const change = changeOf(patch, ctx, current);
	if ('type' in change) {
		result.notUpdated[id] = change;
		return;
	}
	try {
		if (change.rename)
			await ctx.store.renameMailbox(ctx.accountId, id, change.rename);
		if (change.subscribed !== undefined) {
			await ctx.store.setSubscribed(ctx.accountId, id, change.subscribed);
		}
		result.updated[id] = null;
	} catch (error) {
		result.notUpdated[id] = storeSetError(
			error,
			error instanceof StoreError && error.code === 'NOT_FOUND'
				? 'parentId'
				: 'name',
		);
	}
}

async function destroy(
	store: MailStore,
	ctx: CallContext,
	result: SetResult,
	id: string,
	removeEmails: boolean,
) {
	const mailboxes = await store.listMailboxes(ctx.accountId);
	const mailbox = mailboxes.find((one) => one.id === id);
	if (mailbox === undefined) {
		result.notDestroyed[id] = setError('notFound');
	} else if (mailboxes.some((one) => one.parentId === id)) {
		result.notDestroyed[id] = setError(
			'mailboxHasChild',
			'The mailbox has child mailboxes',
		);
	} else if (mailbox.messages > 0 && !removeEmails) {
		result.notDestroyed[id] = setError(
			'mailboxHasEmail',
			'The mailbox holds emails: set onDestroyRemoveEmails',
		);
	} else {
		try {
			await store.deleteMailbox(ctx.accountId, id, {
				removeMessages: removeEmails,
			});
			result.destroyed.push(id);
		} catch (error) {
			result.notDestroyed[id] = storeSetError(error);
		}
	}
}

/** Mailbox/set (RFC 8621 §2.5): creates, then updates, then destroys, each on its own. */
export async function mailboxSet(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, [
		'accountId',
		'ifInState',
		'create',
		'update',
		'destroy',
		'onDestroyRemoveEmails',
	]);
	const accountId = accountOf(args, ctx);
	const removeEmails = boolOf(args, 'onDestroyRemoveEmails');
	const plan = setPlanOf(args, ctx, ctx.settings.limits.maxObjectsInSet);
	const oldState = await checkIfInState(
		ctx.store,
		accountId,
		args['ifInState'],
	);
	const result = new SetResult();
	for (const [creationId, object] of plan.create)
		await create(ctx, result, creationId, object);
	for (const [id, patch] of plan.update) await update(ctx, result, id, patch);
	for (const id of plan.destroy)
		await destroy(ctx.store, ctx, result, id, removeEmails);
	return result.toArgs(
		accountId,
		oldState,
		await stateOf(ctx.store, accountId),
	);
}
