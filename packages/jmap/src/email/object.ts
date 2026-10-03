import type { Message } from '@bumail/store';
import type { Args } from '../api/args';
import type { CallContext } from '../api/context';
import { utcDate } from '../shared/text';
import { CONVENIENCE, headerProperty, headerValue } from './headers';
import { keywordsOf } from './keywords';
import { type Part, parseEmail } from './parse';
import { type Level, levelFor } from './properties';
import { type Bodies, bodiesOf, bodyPart } from './structure';
import { bodyValues, previewOf, type ValueOptions } from './values';

/** What Email/get was asked for, beyond the properties. */
export interface EmailOptions {
	readonly properties: readonly string[];
	readonly bodyProperties: readonly string[];
	readonly values: ValueOptions;
}

/** Bytes of each text part kept for the preview alone. */
const PREVIEW_BYTES = 4096;

function metadata(message: Message): Args {
	return {
		id: message.id,
		blobId: message.blobId,
		threadId: message.threadId,
		mailboxIds: Object.fromEntries(
			message.mailboxes.map(({ mailboxId }) => [mailboxId, true]),
		),
		keywords: keywordsOf(message.flags),
		size: message.size,
		receivedAt: utcDate(message.receivedAt),
	};
}

/** The email's parts, read as far as `level` needs; `undefined` for the metadata alone. */
async function partsOf(
	message: Message,
	level: Level,
	options: EmailOptions,
	ctx: CallContext,
): Promise<Part | undefined> {
	if (level === 'metadata') return undefined;
	const blob = await ctx.store.readContent(ctx.accountId, message.blobId);
	if (blob === undefined)
		throw new Error(`The store has no content for the email "${message.id}"`);
	const { values } = options;
	const wantsValues = values.all || values.text || values.html;
	const budget = { left: ctx.bodyBudget };
	const root = await parseEmail(blob, {
		headerOnly: level === 'header',
		keepText: Math.max(PREVIEW_BYTES, wantsValues ? values.max : 0),
		budget,
	});
	ctx.bodyBudget = budget.left;
	return root;
}

function bodyProperty(
	property: string,
	root: Part,
	bodies: Bodies,
	message: Message,
	options: EmailOptions,
): unknown {
	const part = (one: Part) =>
		bodyPart(one, options.bodyProperties, message.blobId);
	switch (property) {
		case 'bodyStructure':
			return bodyPart(
				root,
				options.bodyProperties.includes('subParts')
					? options.bodyProperties
					: [...options.bodyProperties, 'subParts'],
				message.blobId,
			);
		case 'textBody':
			return bodies.textBody.map(part);
		case 'htmlBody':
			return bodies.htmlBody.map(part);
		case 'attachments':
			return bodies.attachments.map(part);
		case 'hasAttachment':
			return bodies.attachments.length > 0;
		case 'preview':
			return previewOf(bodies);
		default:
			return bodyValues(root, bodies, options.values);
	}
}

/** One Email (RFC 8621 §4.1), with the properties asked for. */
export async function emailObject(
	message: Message,
	options: EmailOptions,
	ctx: CallContext,
): Promise<Args> {
	const { properties } = options;
	const meta = metadata(message);
	const root = await partsOf(message, levelFor(properties), options, ctx);
	const bodies = root === undefined ? undefined : bodiesOf(root);
	const object: Args = { id: message.id };
	for (const property of properties) {
		if (property in meta) object[property] = meta[property];
		else if (root === undefined || bodies === undefined) continue;
		else if (property === 'headers') {
			object[property] = [...root.headers].map(({ name, value }) => ({
				name,
				value,
			}));
		} else if (property in CONVENIENCE) {
			object[property] = headerValue(
				root.headers,
				CONVENIENCE[property] as never,
			);
		} else if (property.startsWith('header:')) {
			object[property] = headerValue(
				root.headers,
				headerProperty(property) as never,
			);
		} else {
			object[property] = bodyProperty(property, root, bodies, message, options);
		}
	}
	return object;
}
