import { encodeBase64 } from '../encoding/base64';
import { hasControl } from '../encoding/bytes';
import { encodeQuotedPrintable } from '../encoding/quoted-printable';
import { MimeError } from '../errors';
import { formatParameter } from '../headers/parameters';
import { foldHeader } from './fold';
import type { Attachment } from './options';

export interface Part {
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string;
}

function randomHex(bytes: number): string {
	return crypto.getRandomValues(new Uint8Array(bytes)).toHex();
}

/** Can go out as `7bit`: ASCII, no control but TAB and CRLF, lines up to 998. */
function isSevenBit(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code > 0x7e) return false;
		if (code === 0x0d && text.charCodeAt(i + 1) !== 0x0a) return false;
		if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
			return false;
	}
	return text.split('\r\n').every((line) => line.length <= 998);
}

export function textPart(content: string, subtype: 'plain' | 'html'): Part {
	const normal = content.replace(/\r?\n/g, '\r\n');
	const sevenBit = isSevenBit(normal);
	return {
		headers: [
			['Content-Type', `text/${subtype}; charset=utf-8`],
			['Content-Transfer-Encoding', sevenBit ? '7bit' : 'quoted-printable'],
		],
		body: sevenBit ? normal : encodeQuotedPrintable(normal),
	};
}

/** `type/subtype`, each an RFC 2045 §5.1 token: no parameter, no quote. */
const MEDIA_TYPE =
	/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function attachmentPart(attachment: Attachment): Part {
	const type = attachment.contentType ?? 'application/octet-stream';
	if (!MEDIA_TYPE.test(type)) {
		throw new MimeError(
			'INVALID_OPTION',
			`"${JSON.stringify(type).slice(1, -1)}" is not a media type`,
		);
	}
	const content =
		typeof attachment.content === 'string'
			? new TextEncoder().encode(attachment.content)
			: attachment.content;
	const id = attachment.contentId;
	const name = attachment.filename;
	if (name !== undefined && hasControl(name)) {
		throw new MimeError(
			'INVALID_OPTION',
			'A file name cannot hold a control character',
		);
	}
	const headers: [string, string][] = [
		[
			'Content-Type',
			name === undefined ? type : `${type}; ${formatParameter('name', name)}`,
		],
		['Content-Transfer-Encoding', 'base64'],
		[
			'Content-Disposition',
			`${id === undefined ? 'attachment' : 'inline'}${name === undefined ? '' : `; ${formatParameter('filename', name)}`}`,
		],
	];
	if (id !== undefined)
		headers.push(['Content-ID', `<${checkId(id, 'contentId')}>`]);
	return { headers, body: encodeBase64(content) };
}

/** An id between angle brackets (RFC 5322 §3.6.4) cannot hold brackets, white space or controls. */
export function checkId(id: string, option: string): string {
	if (!/^[\x21-\x3b\x3d\x3f-\x7e]+$/.test(id)) {
		throw new MimeError(
			'INVALID_OPTION',
			`${option}: "${JSON.stringify(id).slice(1, -1)}" is not a message id`,
		);
	}
	return id;
}

/** The parts wrapped in a multipart, or the single part as it is. */
export function multipart(subtype: string, parts: readonly Part[]): Part {
	if (parts.length === 1) return parts[0] as Part;
	// `=_` cannot occur in quoted-printable or base64 output (RFC 2045 §6.7, §6.8).
	const mark = `=_bumail_${randomHex(12)}`;
	const body = `${parts.map((part) => `--${mark}\r\n${render(part)}`).join('\r\n')}\r\n--${mark}--`;
	// RFC 2387 §3.1: a multipart/related names the type of its root, its first part.
	const root = (
		parts[0]?.headers.find(([name]) => name === 'Content-Type')?.[1] ?? ''
	).split(';')[0];
	const type = subtype === 'related' ? `; type="${root}"` : '';
	return {
		headers: [
			['Content-Type', `multipart/${subtype}; boundary="${mark}"${type}`],
		],
		body,
	};
}

export function render(part: Part): string {
	return `${part.headers.map(([name, value]) => foldHeader(name, value)).join('\r\n')}\r\n\r\n${part.body}`;
}
