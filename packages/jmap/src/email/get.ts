import type { Message } from '@bumail/store';
import {
	type Args,
	accountOf,
	boolOf,
	idsOf,
	onlyKnown,
	propertiesOf,
	uintOf,
} from '../api/args';
import { changes } from '../api/changes';
import type { CallContext } from '../api/context';
import { MethodError } from '../api/errors';
import { stateOf } from '../api/state';
import { headerProperty } from './headers';
import { emailObject } from './object';
import { DEFAULT_EMAIL_PROPERTIES, isEmailProperty } from './properties';
import { BODY_PART_PROPERTIES, DEFAULT_BODY_PROPERTIES } from './structure';

const ARGUMENTS = [
	'accountId',
	'ids',
	'properties',
	'bodyProperties',
	'fetchTextBodyValues',
	'fetchHTMLBodyValues',
	'fetchAllBodyValues',
	'maxBodyValueBytes',
];

const isBodyProperty = (property: string) =>
	(BODY_PART_PROPERTIES as readonly string[]).includes(property) ||
	headerProperty(property) !== undefined;

async function messagesOf(
	ctx: CallContext,
	ids: readonly string[] | null,
): Promise<{ found: Message[]; notFound: string[] }> {
	const max = ctx.settings.limits.maxObjectsInGet;
	if (ids === null) {
		const page = await ctx.store.listAccountMessages(ctx.accountId, {
			limit: max,
		});
		if (page.total > max)
			throw new MethodError(
				'requestTooLarge',
				`The account has more than ${max} emails: ask for ids`,
			);
		return { found: [...page.messages], notFound: [] };
	}
	const found: Message[] = [];
	const notFound: string[] = [];
	for (const id of new Set(ids)) {
		const message = await ctx.store.getMessage(ctx.accountId, id);
		if (message === undefined) notFound.push(id);
		else found.push(message);
	}
	return { found, notFound };
}

/** Email/get (RFC 8621 §4.2). */
export async function emailGet(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, ARGUMENTS);
	const accountId = accountOf(args, ctx);
	const ids = idsOf(args, 'ids', ctx, ctx.settings.limits.maxObjectsInGet);
	const properties = propertiesOf(
		args,
		'properties',
		isEmailProperty,
		DEFAULT_EMAIL_PROPERTIES,
	);
	const bodyProperties = propertiesOf(
		args,
		'bodyProperties',
		isBodyProperty,
		DEFAULT_BODY_PROPERTIES,
	);
	const serverMax = ctx.settings.limits.maxBodyValueBytes;
	const asked = uintOf(args, 'maxBodyValueBytes') ?? 0;
	const values = {
		text: boolOf(args, 'fetchTextBodyValues'),
		html: boolOf(args, 'fetchHTMLBodyValues'),
		all: boolOf(args, 'fetchAllBodyValues'),
		max: asked === 0 ? serverMax : Math.min(asked, serverMax),
	};
	const state = await stateOf(ctx.store, accountId);
	const { found, notFound } = await messagesOf(ctx, ids);
	const list: Args[] = [];
	for (const message of found) {
		list.push(
			await emailObject(message, { properties, bodyProperties, values }, ctx),
		);
	}
	return { accountId, state, list, notFound };
}

/** Email/changes (RFC 8621 §4.3). */
export function emailChanges(args: Args, ctx: CallContext): Promise<Args> {
	return changes(args, ctx, (since, limit) =>
		ctx.store.messageChanges(
			ctx.accountId,
			since,
			limit === undefined ? {} : { limit },
		),
	);
}
