import { CONVENIENCE, headerProperty } from './headers';

/** What Email/get reads for a property: the store's record, the header, or the whole message. */
export type Level = 'metadata' | 'header' | 'body';

const METADATA = [
	'id',
	'blobId',
	'threadId',
	'mailboxIds',
	'keywords',
	'size',
	'receivedAt',
];
const BODY = [
	'bodyStructure',
	'bodyValues',
	'textBody',
	'htmlBody',
	'attachments',
	'hasAttachment',
	'preview',
];

/** RFC 8621 §4.2's default `properties`. */
export const DEFAULT_EMAIL_PROPERTIES = [
	...METADATA,
	'messageId',
	'inReplyTo',
	'references',
	'sender',
	'from',
	'to',
	'cc',
	'bcc',
	'replyTo',
	'subject',
	'sentAt',
	'hasAttachment',
	'preview',
	'bodyValues',
	'textBody',
	'htmlBody',
	'attachments',
];

export function levelOf(property: string): Level | undefined {
	if (METADATA.includes(property)) return 'metadata';
	if (BODY.includes(property)) return 'body';
	if (property === 'headers' || property in CONVENIENCE) return 'header';
	return headerProperty(property) === undefined ? undefined : 'header';
}

export const isEmailProperty = (property: string) =>
	levelOf(property) !== undefined;

/** What the properties need read, the most of them. */
export function levelFor(properties: readonly string[]): Level {
	const levels = properties.map(levelOf);
	if (levels.includes('body')) return 'body';
	return levels.includes('header') ? 'header' : 'metadata';
}
