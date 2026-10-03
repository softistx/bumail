import {
	charsetLabel,
	decodeEncodedWords,
	parseContentDisposition,
} from '@bumail/mime';
import type { Args } from '../api/args';
import { headerProperty, headerValue } from './headers';
import { isMultipart, type Part, partIdOf } from './parse';

export const BODY_PART_PROPERTIES = [
	'partId',
	'blobId',
	'size',
	'headers',
	'name',
	'type',
	'charset',
	'disposition',
	'cid',
	'language',
	'location',
	'subParts',
] as const;

/** RFC 8621 §4.2's default `bodyProperties`. */
export const DEFAULT_BODY_PROPERTIES = [
	'partId',
	'blobId',
	'size',
	'name',
	'type',
	'charset',
	'disposition',
	'cid',
	'language',
	'location',
] as const;

/** A part's blob id: the email's blob and the part's id, `-` for `.`. */
export const partBlobId = (blobId: string, part: Part) =>
	`${blobId}_${partIdOf(part).replaceAll('.', '-')}`;

function dispositionOf(part: Part) {
	const value = part.headers.get('content-disposition');
	return value === undefined ? undefined : parseContentDisposition(value);
}

function nameOf(part: Part): string | null {
	const name =
		dispositionOf(part)?.parameters['filename'] ??
		part.contentType.parameters['name'];
	return name === undefined ? null : decodeEncodedWords(name);
}

function charsetOf(part: Part): string | null {
	const charset = part.contentType.parameters['charset'];
	if (charset !== undefined) return charset;
	return part.contentType.type === 'text' ? 'us-ascii' : null;
}

/** An EmailBodyPart (RFC 8621 §4.1.4) with the properties asked for. */
export function bodyPart(
	part: Part,
	properties: readonly string[],
	blobId: string,
): Args {
	const leaf = !isMultipart(part);
	const value = (property: string): unknown => {
		switch (property) {
			case 'partId':
				return leaf ? partIdOf(part) : null;
			case 'blobId':
				return leaf ? partBlobId(blobId, part) : null;
			case 'size':
				return leaf ? part.size : 0;
			case 'headers':
				return [...part.headers].map(({ name, value: raw }) => ({
					name,
					value: raw,
				}));
			case 'name':
				return nameOf(part);
			case 'type':
				return part.contentType.mediaType.toLowerCase();
			case 'charset':
				return charsetOf(part);
			case 'disposition':
				return dispositionOf(part)?.type.toLowerCase() ?? null;
			case 'cid':
				return (
					part.headers.get('content-id')?.trim().replace(/^<|>$/g, '') ?? null
				);
			case 'language': {
				const language = part.headers.get('content-language');
				return language === undefined
					? null
					: language
							.split(',')
							.map((tag) => tag.trim())
							.filter(Boolean);
			}
			case 'location':
				return part.headers.get('content-location')?.trim() ?? null;
			case 'subParts':
				return leaf
					? null
					: part.children.map((child) => bodyPart(child, properties, blobId));
			default: {
				const header = headerProperty(property);
				return header === undefined ? null : headerValue(part.headers, header);
			}
		}
	};
	return Object.fromEntries(
		properties.map((property) => [property, value(property)]),
	);
}

const isInlineMedia = (type: string) => /^(image|audio|video)\//.test(type);

/** The text, HTML and attachment parts, by RFC 8621 §4.1.4's algorithm. */
export interface Bodies {
	readonly textBody: Part[];
	readonly htmlBody: Part[];
	readonly attachments: Part[];
}

function parseStructure(
	parts: readonly Part[],
	multipartType: string,
	inAlternative: boolean,
	html: Part[] | null,
	text: Part[] | null,
	attachments: Part[],
): void {
	const textLength = text ? text.length : -1;
	const htmlLength = html ? html.length : -1;
	for (const [i, part] of parts.entries()) {
		const type = part.contentType.mediaType.toLowerCase();
		const isInline =
			dispositionOf(part)?.type.toLowerCase() !== 'attachment' &&
			(type === 'text/plain' || type === 'text/html' || isInlineMedia(type)) &&
			(i === 0 ||
				(multipartType !== 'related' &&
					(isInlineMedia(type) || nameOf(part) === null)));
		if (isMultipart(part)) {
			const sub = part.contentType.subtype.toLowerCase();
			parseStructure(
				part.children,
				sub,
				inAlternative || sub === 'alternative',
				html,
				text,
				attachments,
			);
		} else if (isInline) {
			if (multipartType === 'alternative') {
				if (type === 'text/plain') text?.push(part);
				else if (type === 'text/html') html?.push(part);
				else attachments.push(part);
				continue;
			}
			if (inAlternative) {
				if (type === 'text/plain') html = null;
				if (type === 'text/html') text = null;
			}
			text?.push(part);
			html?.push(part);
			if ((!text || !html) && isInlineMedia(type)) attachments.push(part);
		} else {
			attachments.push(part);
		}
	}
	if (multipartType === 'alternative' && text && html) {
		if (textLength === text.length && htmlLength !== html.length)
			text.push(...html.slice(htmlLength));
		if (htmlLength === html.length && textLength !== text.length)
			html.push(...text.slice(textLength));
	}
}

export function bodiesOf(root: Part): Bodies {
	const bodies: Bodies = { textBody: [], htmlBody: [], attachments: [] };
	parseStructure(
		[root],
		'mixed',
		false,
		bodies.htmlBody,
		bodies.textBody,
		bodies.attachments,
	);
	return bodies;
}

/** A part's kept bytes as text, and whether its charset was a problem. */
export function textOf(part: Part): { text: string; problem: boolean } {
	const bytes = new Uint8Array(part.keptSize);
	let offset = 0;
	for (const chunk of part.kept) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const label = charsetLabel(charsetOf(part) ?? 'utf-8') ?? 'utf-8';
	// A body kept in part may end inside a character: that is no problem.
	const stream = part.keptSize < part.size;
	try {
		const decoder = new TextDecoder(label, { fatal: true });
		return { text: decoder.decode(bytes, { stream }), problem: false };
	} catch {
		return { text: new TextDecoder(label).decode(bytes), problem: true };
	}
}
