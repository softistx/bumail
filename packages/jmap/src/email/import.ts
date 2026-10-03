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
interface EmailImport {
	readonly blobId: string;
	readonly mailboxIds: readonly string[];
	readonly flags: readonly string[];
	readonly receivedAt?: Date;
}

const invalid = (property: string, description: string): SetError =>
	setError('invalidProperties', description, [property]);

function importOf(object: Args, ctx: CallContext): EmailImport | SetError {
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

/** Creates one email from a blob: in its first mailbox, then linked into the others. */
export async function importEmail(
	object: Args,
	ctx: CallContext,
): Promise<Args | SetError> {
	const checked = importOf(object, ctx);
	if ('type' in checked) return checked;
	const content = await bytesOf(ctx.store, ctx, checked.blobId);
	if (content === undefined)
		return setError('blobNotFound', 'No blob has this id', ['blobId']);
	const [first, ...others] = checked.mailboxIds as [string, ...string[]];
	try {
		const message = await ctx.store.addMessage(ctx.accountId, first, {
			content,
			flags: checked.flags,
			...(checked.receivedAt === undefined
				? {}
				: { receivedAt: checked.receivedAt }),
		});
		for (const mailboxId of others)
			await ctx.store.linkMessages(ctx.accountId, [message.id], mailboxId);
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

/** Email/import (RFC 8621 §4.8): emails created from uploaded blobs. */
export async function emailImport(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, ['accountId', 'ifInState', 'emails']);
	const accountId = accountOf(args, ctx);
	const { emails } = args;
	if (!isObject(emails)) throw invalidArguments('emails must be an object');
	const entries = Object.entries(emails);
	const max = ctx.settings.limits.maxObjectsInSet;
	if (entries.length > max)
		throw new MethodError(
			'requestTooLarge',
			`emails holds more than ${max} emails`,
		);
	const oldState = await checkIfInState(
		ctx.store,
		accountId,
		args['ifInState'],
	);
	const created: Record<string, Args> = {};
	const notCreated: Record<string, SetError> = {};
	for (const [creationId, object] of entries) {
		if (!isId(creationId) || !isObject(object))
			throw invalidArguments(
				`emails[${quoted(creationId)}] is not an EmailImport`,
			);
		const result = await importEmail(object, ctx);
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
