import {
	decodeEncodedWords,
	type MessageHeaders,
	parseAddressList,
	parseDate,
} from '@bumail/mime';
import { utcDate } from '../shared/text';

/** The parsed forms of a header field (RFC 8621 §4.1.2). */
export const FORMS = [
	'asRaw',
	'asText',
	'asAddresses',
	'asGroupedAddresses',
	'asMessageIds',
	'asDate',
	'asURLs',
] as const;

export type Form = (typeof FORMS)[number];

/** A `header:` property, parsed: `header:From:asAddresses:all`. */
export interface HeaderProperty {
	readonly name: string;
	readonly form: Form;
	readonly all: boolean;
}

const FIELD_NAME = /^[!-9;-~]{1,255}$/;

/** A `header:…` property name, or `undefined` when it is not one. */
export function headerProperty(property: string): HeaderProperty | undefined {
	if (!property.startsWith('header:')) return undefined;
	const parts = property.slice(7).split(':');
	const [name = ''] = parts;
	if (!FIELD_NAME.test(name)) return undefined;
	let rest = parts.slice(1);
	const all = rest.at(-1) === 'all';
	if (all) rest = rest.slice(0, -1);
	if (rest.length > 1) return undefined;
	const form = (rest[0] ?? 'asRaw') as Form;
	if (!FORMS.includes(form)) return undefined;
	return { name, form, all };
}

type EmailAddress = { name: string | null; email: string };

function addresses(value: string): EmailAddress[] {
	return parseAddressList(value)
		.flatMap((address) => ('group' in address ? address.members : [address]))
		.map(({ name, address }) => ({
			name: name === '' ? null : name,
			email: address,
		}));
}

function grouped(value: string) {
	return parseAddressList(value).map((address) =>
		'group' in address
			? {
					name: address.group,
					addresses: address.members.map(({ name, address: email }) => ({
						name: name === '' ? null : name,
						email,
					})),
				}
			: {
					name: null,
					addresses: [
						{
							name: address.name === '' ? null : address.name,
							email: address.address,
						},
					],
				},
	);
}

function messageIds(value: string): string[] | null {
	const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map(
		(match) => match[1] as string,
	);
	if (ids.length > 0) return ids;
	const bare = value.trim();
	return /^[^<>\s]+@[^<>\s]+$/.test(bare) ? [bare] : null;
}

function urls(value: string): string[] | null {
	const found = [...value.matchAll(/<([^<>]+)>/g)].map((match) =>
		(match[1] as string).trim(),
	);
	return found.length > 0 ? found : null;
}

/** One header field's value in a parsed form (RFC 8621 §4.1.2). */
export function parsed(value: string, form: Form): unknown {
	switch (form) {
		case 'asRaw':
			return value;
		case 'asText':
			return decodeEncodedWords(value).replace(/\s+/g, ' ').trim();
		case 'asAddresses':
			return addresses(value);
		case 'asGroupedAddresses':
			return grouped(value);
		case 'asMessageIds':
			return messageIds(value);
		case 'asDate': {
			const date = parseDate(value);
			return date === undefined ? null : utcDate(date);
		}
		default:
			return urls(value);
	}
}

/** A `header:` property's value: the last field of that name, or every one with `:all`. */
export function headerValue(
	headers: MessageHeaders,
	property: HeaderProperty,
): unknown {
	const values = headers.getAll(property.name);
	if (property.all) return values.map((value) => parsed(value, property.form));
	const last = values.at(-1);
	return last === undefined ? null : parsed(last, property.form);
}

/** The convenience properties (RFC 8621 §4.1.3), each a `header:` form. */
export const CONVENIENCE: Readonly<Record<string, HeaderProperty>> = {
	messageId: { name: 'Message-ID', form: 'asMessageIds', all: false },
	inReplyTo: { name: 'In-Reply-To', form: 'asMessageIds', all: false },
	references: { name: 'References', form: 'asMessageIds', all: false },
	sender: { name: 'Sender', form: 'asAddresses', all: false },
	from: { name: 'From', form: 'asAddresses', all: false },
	to: { name: 'To', form: 'asAddresses', all: false },
	cc: { name: 'Cc', form: 'asAddresses', all: false },
	bcc: { name: 'Bcc', form: 'asAddresses', all: false },
	replyTo: { name: 'Reply-To', form: 'asAddresses', all: false },
	subject: { name: 'Subject', form: 'asText', all: false },
	sentAt: { name: 'Date', form: 'asDate', all: false },
};
