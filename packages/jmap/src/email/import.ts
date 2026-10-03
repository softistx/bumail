import type { MailStore } from '@bumail/store';
import { type Args, accountOf, idOf, isObject, onlyKnown } from '../api/args';
import type { CallContext } from '../api/context';
import {
	invalidArguments,
	MethodError,
	type SetError,
	setError,
} from '../api/errors';
import { storeSetError } from '../api/set';
import { checkIfInState, stateOf } from '../api/state';
import { isId, quoted } from '../shared/text';
import { flagOf, isKeyword } from './keywords';

const FIELDS = ['blobId', 'mailboxIds', 'keywords', 'receivedAt'];

/** An EmailImport (RFC 8621 §4.8), checked. */
export interface EmailImport {
	readonly blobId: string;
	readonly mailboxIds: readonly string[];
	readonly flags: readonly string[];
	readonly receivedAt?: Date;
}

const invalid = (property: string, description: string): SetError =>
	setError('invalidProperties', description, [property]);

/** An EmailImport's properties, checked, or the SetError that refuses them. */
export function importOf(
	object: Args,
	ctx: CallContext,
): EmailImport | SetError {
	const unknown = Object.keys(object).find((key) => !FIELDS.includes(key));
	if (unknown !== undefined)
		return invalid(
			unknown,
			'An email is created from an uploaded blobId: this property cannot be set',
		);
	const { blobId, mailboxIds, keywords = {}, receivedAt } = object;
	if (!isId(blobId)) return invalid('blobId', 'blobId is required');
	const mailboxes = isObject(mailboxIds)
		? Object.entries(mailboxIds).map(([id, value]) =>
				value === true ? idOf(id, ctx) : undefined,
			)
		: [];
	if (
		mailboxes.length === 0 ||
		mailboxes.length > 1000 ||
		mailboxes.includes(undefined)
	) {
		return invalid(
			'mailboxIds',
			'mailboxIds names at least one mailbox, each set to true',
		);
	}
	if (
		!isObject(keywords) ||
		!Object.entries(keywords).every(
			([key, value]) => isKeyword(key) && value === true,
		)
	) {
		return invalid('keywords', 'keywords is an object of keywords set to true');
	}
	const date =
		typeof receivedAt === 'string' ? new Date(receivedAt) : undefined;
	if (
		receivedAt !== undefined &&
		(date === undefined || Number.isNaN(date.getTime()))
	) {
		return invalid('receivedAt', 'receivedAt is a UTCDate');
	}
	return {
		blobId,
		mailboxIds: mailboxes as string[],
		flags: Object.keys(keywords).map(flagOf),
		...(date === undefined ? {} : { receivedAt: date }),
	};
}

async function bytesOf(
	store: MailStore,
	ctx: CallContext,
	blobId: string,
): Promise<Uint8Array | undefined> {
	const upload = ctx.uploads.get(ctx.accountId, blobId);
	if (upload !== undefined) return upload.bytes;
	const blob = await store.readContent(ctx.accountId, blobId);
	return blob === undefined
		? undefined
		: new Uint8Array(await blob.arrayBuffer());
}

/** The account's mailbox ids, read once for every create of a call. */
export async function mailboxIdsOf(ctx: CallContext): Promise<Set<string>> {
	const mailboxes = await ctx.store.listMailboxes(ctx.accountId);
	return new Set(mailboxes.map(({ id }) => id));
}

/** Adds the message to its first mailbox and links it into the others; removed again if a link fails. */
async function addEverywhere(
	ctx: CallContext,
	checked: EmailImport,
	content: Uint8Array,
) {
	const [first, ...others] = checked.mailboxIds as [string, ...string[]];
	const message = await ctx.store.addMessage(ctx.accountId, first, {
		content,
		flags: checked.flags,
		...(checked.receivedAt === undefined
			? {}
			: { receivedAt: checked.receivedAt }),
	});
	try {
		for (const mailboxId of others)
			await ctx.store.linkMessages(ctx.accountId, [message.id], mailboxId);
	} catch (error) {
		await ctx.store.destroyMessages(ctx.accountId, [message.id]);
		throw error;
	}
	return message;
}

/**
 * Creates one email from a blob, once every mailbox it names is known to
 * be one of `mailboxes`: an email is never left in some of them only.
 */
export async function importEmail(
	checked: EmailImport,
	ctx: CallContext,
	mailboxes: ReadonlySet<string>,
): Promise<Args | SetError> {
	if (checked.mailboxIds.some((id) => !mailboxes.has(id)))
		return invalid(
			'mailboxIds',
			'mailboxIds names a mailbox the account does not have',
		);
	const content = await bytesOf(ctx.store, ctx, checked.blobId);
	if (content === undefined)
		return setError('blobNotFound', 'No blob has this id', ['blobId']);
	try {
		const message = await addEverywhere(ctx, checked, content);
		return {
			id: message.id,
			blobId: message.blobId,
			threadId: message.threadId,
			size: message.size,
		};
	} catch (error) {
		return storeSetError(error, 'mailboxIds');
	}
}

/** Every entry of `emails`, checked before any is imported. */
function entriesOf(
	emails: Record<string, unknown>,
	ctx: CallContext,
): [string, EmailImport | SetError][] {
	const entries = Object.entries(emails);
	const max = ctx.settings.limits.maxObjectsInSet;
	if (entries.length > max)
		throw new MethodError(
			'requestTooLarge',
			`emails holds more than ${max} emails`,
		);
	for (const [creationId, object] of entries) {
		if (!isId(creationId) || !isObject(object))
			throw invalidArguments(
				`emails[${quoted(creationId)}] is not an EmailImport`,
			);
	}
	return entries.map(([creationId, object]) => [
		creationId,
		importOf(object as Args, ctx),
	]);
}

/** Email/import (RFC 8621 §4.8): emails created from uploaded blobs. */
export async function emailImport(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, ['accountId', 'ifInState', 'emails']);
	const accountId = accountOf(args, ctx);
	const { emails } = args;
	if (!isObject(emails)) throw invalidArguments('emails must be an object');
	const entries = entriesOf(emails, ctx);
	const oldState = await checkIfInState(
		ctx.store,
		accountId,
		args['ifInState'],
	);
	const mailboxes = await mailboxIdsOf(ctx);
	const created: Record<string, Args> = {};
	const notCreated: Record<string, SetError> = {};
	for (const [creationId, checked] of entries) {
		const result =
			'type' in checked ? checked : await importEmail(checked, ctx, mailboxes);
		if ('type' in result) notCreated[creationId] = result as SetError;
		else {
			created[creationId] = result;
			ctx.created.set(creationId, result['id'] as string);
		}
	}
	return {
		accountId,
		oldState,
		newState: await stateOf(ctx.store, accountId),
		created: Object.keys(created).length === 0 ? null : created,
		notCreated: Object.keys(notCreated).length === 0 ? null : notCreated,
	};
}
