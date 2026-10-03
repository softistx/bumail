import { parseContentDisposition } from '@bumail/mime';
import type { Response } from '../protocol/response';
import { EMPTY_ENVELOPE, envelope } from './envelope';
import type { Entity } from './structure';

/** A part of no content: what a multipart with no part, or an unreadable message, holds. */
const EMPTY_PART = '("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 0 0)';

/**
 * A parameter value in 7 bits: RFC 2231's `name*` with `utf-8''` and
 * percent-encoding when the decoded value is not ASCII.
 */
function parameter(out: Response, name: string, value: string): void {
	if (/^[\x20-\x7e]*$/.test(value)) {
		out.string(name).text(' ').string(value);
		return;
	}
	let encoded = "utf-8''";
	for (const byte of new TextEncoder().encode(value)) {
		const char = String.fromCharCode(byte);
		encoded += /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)
			? char
			: `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
	}
	out.string(`${name}*`).text(' ').string(encoded);
}

/** `("name" "value" …)`, or NIL with none. */
function parameters(
	out: Response,
	values: Readonly<Record<string, string>>,
): void {
	const names = Object.keys(values);
	if (names.length === 0) {
		out.text('NIL');
		return;
	}
	out.text('(');
	names.forEach((name, i) => {
		if (i > 0) out.text(' ');
		parameter(out, name, values[name] as string);
	});
	out.text(')');
}

/** The extension data BODYSTRUCTURE adds after a part's fields: disposition, language, location. */
function trailer(out: Response, entity: Entity): void {
	const value = entity.headers.get('content-disposition');
	out.text(' ');
	if (value === undefined) out.text('NIL');
	else {
		const disposition = parseContentDisposition(value);
		out
			.text('(')
			.string(disposition.type || 'attachment')
			.text(' ');
		parameters(out, disposition.parameters);
		out.text(')');
	}
	const languages = (entity.headers.get('content-language') ?? '')
		.split(',')
		.map((tag) => tag.trim())
		.filter((tag) => tag !== '');
	out.text(' ');
	if (languages.length === 0) out.text('NIL');
	else {
		out.text('(');
		out.string(languages[0] as string);
		for (const tag of languages.slice(1)) out.text(' ').string(tag);
		out.text(')');
	}
	out.text(' ').nstring(entity.headers.get('content-location'));
}

function single(out: Response, entity: Entity, extended: boolean): void {
	const { contentType, headers } = entity;
	const encoding =
		headers.get('content-transfer-encoding')?.trim().toUpperCase() || '7BIT';
	out
		.text('(')
		.string(contentType.type)
		.text(' ')
		.string(contentType.subtype)
		.text(' ');
	// RFC 2045 §5.2: text without a charset is US-ASCII.
	const textDefault =
		contentType.type === 'text' &&
		contentType.parameters['charset'] === undefined
			? { charset: 'us-ascii' }
			: {};
	parameters(out, { ...textDefault, ...contentType.parameters });
	out
		.text(' ')
		.nstring(headers.get('content-id'))
		.text(' ')
		.nstring(headers.get('content-description'))
		.text(' ')
		.string(encoding)
		.text(` ${entity.end - entity.bodyStart}`);
	const { mediaType } = contentType;
	if (mediaType === 'message/rfc822' || mediaType === 'message/global') {
		out.text(' ');
		if (entity.message) {
			envelope(out, entity.message.headers);
			out.text(' ');
			bodyStructure(out, entity.message, extended);
		} else out.text(`${EMPTY_ENVELOPE} ${EMPTY_PART}`);
		out.text(` ${entity.lines}`);
	} else if (contentType.type === 'text') out.text(` ${entity.lines}`);
	if (extended) {
		out.text(' ').nstring(headers.get('content-md5'));
		trailer(out, entity);
	}
	out.text(')');
}

/**
 * BODYSTRUCTURE, or BODY without `extended` (RFC 9051 §7.5.2): a part's
 * type, parameters, id, description, encoding, size and lines; a
 * message/rfc822 part's envelope and structure; a multipart's parts, then
 * its subtype. A multipart with no part found gets one empty part, as the
 * grammar needs one at least.
 */
export function bodyStructure(
	out: Response,
	entity: Entity,
	extended: boolean,
): void {
	if (entity.contentType.type !== 'multipart') {
		single(out, entity, extended);
		return;
	}
	out.text('(');
	if (entity.children.length === 0) out.text(EMPTY_PART);
	for (const child of entity.children) bodyStructure(out, child, extended);
	out.text(' ').string(entity.contentType.subtype);
	if (extended) {
		out.text(' ');
		parameters(out, entity.contentType.parameters);
		trailer(out, entity);
	}
	out.text(')');
}
