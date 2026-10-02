import { encodeBase64 } from '../encoding/base64';
import { encodeQuotedPrintable } from '../encoding/quoted-printable';
import { MimeError } from '../errors';
import {
	formatMailbox,
	type Mailbox,
	mailboxesOf,
	parseAddressList,
} from '../headers/addresses';
import { formatDate } from '../headers/date';
import { encodeHeaderValue } from '../headers/encoded-words';
import { foldHeader } from './fold';

export type AddressInput = Mailbox | string;

/** A file attached to a message. */
export interface Attachment {
	readonly content: Uint8Array | string;
	readonly filename?: string;
	/** Default `application/octet-stream`. */
	readonly contentType?: string;
	/**
	 * A `Content-ID`, without brackets: the HTML body shows the file with
	 * `<img src="cid:…">`, and it travels in a `multipart/related`.
	 */
	readonly contentId?: string;
}

export interface MessageOptions {
	readonly from: AddressInput;
	readonly to?: AddressInput | readonly AddressInput[];
	readonly cc?: AddressInput | readonly AddressInput[];
	/** Never written into the message: only `envelopeOf` reads it. */
	readonly bcc?: AddressInput | readonly AddressInput[];
	readonly replyTo?: AddressInput | readonly AddressInput[];
	readonly sender?: AddressInput;
	readonly subject?: string;
	/** Default: now. */
	readonly date?: Date;
	/** Without brackets. Default: a random one at the sender's domain. */
	readonly messageId?: string;
	readonly inReplyTo?: string;
	readonly references?: readonly string[];
	readonly text?: string;
	readonly html?: string;
	readonly attachments?: readonly Attachment[];
	/** More fields, written after the others. Values are encoded when they are not ASCII. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** Who a message goes from and to, as SMTP's `MAIL FROM` and `RCPT TO` need it. */
export interface Envelope {
	readonly from: string;
	readonly to: readonly string[];
}

function list(
	input: AddressInput | readonly AddressInput[] | undefined,
): AddressInput[] {
	if (input === undefined) return [];
	return Array.isArray(input) ? [...input] : [input as AddressInput];
}

function addressOf(input: AddressInput): string {
	if (typeof input !== 'string') return input.address;
	const [first] = mailboxesOf(parseAddressList(input));
	if (!first) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`"${input}" is not an e-mail address`,
		);
	}
	return first.address;
}

function toMailbox(input: AddressInput): Mailbox {
	if (typeof input !== 'string') return input;
	const [first] = mailboxesOf(parseAddressList(input));
	if (!first) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`"${input}" is not an e-mail address`,
		);
	}
	return first;
}

/** The envelope of a message: its sender, and every recipient — To, Cc and Bcc — once. */
export function envelopeOf(options: MessageOptions): Envelope {
	const to = [
		...list(options.to),
		...list(options.cc),
		...list(options.bcc),
	].map(addressOf);
	return { from: addressOf(options.from), to: [...new Set(to)] };
}

function randomHex(bytes: number): string {
	return crypto.getRandomValues(new Uint8Array(bytes)).toHex();
}

function boundary(): string {
	// `=_` cannot occur in quoted-printable or base64 output (RFC 2045 §6.7, §6.8).
	return `=_bumail_${randomHex(12)}`;
}

/** A parameter value: quoted when ASCII, RFC 2231-encoded in UTF-8 when not. */
function parameter(name: string, value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) {
		return `${name}="${value.replace(/(["\\])/g, '\\$1')}"`;
	}
	const encoded = [...new TextEncoder().encode(value)]
		.map((byte) =>
			/[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(byte))
				? String.fromCharCode(byte)
				: `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
		)
		.join('');
	return `${name}*=utf-8''${encoded}`;
}

interface Part {
	readonly headers: [string, string][];
	readonly body: string;
}

function textPart(content: string, subtype: 'plain' | 'html'): Part {
	const normal = content.replace(/\r?\n/g, '\r\n');
	const sevenBit =
		[...normal].every((char) => char.charCodeAt(0) < 0x80) &&
		normal.split('\r\n').every((line) => line.length <= 998);
	return {
		headers: [
			['Content-Type', `text/${subtype}; charset=utf-8`],
			['Content-Transfer-Encoding', sevenBit ? '7bit' : 'quoted-printable'],
		],
		body: sevenBit ? normal : encodeQuotedPrintable(normal),
	};
}

function attachmentPart(attachment: Attachment): Part {
	const type = attachment.contentType ?? 'application/octet-stream';
	if (/[\r\n]/.test(type)) {
		throw new MimeError(
			'INVALID_OPTION',
			'An attachment content type holds a line break',
		);
	}
	const content =
		typeof attachment.content === 'string'
			? new TextEncoder().encode(attachment.content)
			: attachment.content;
	const inline = attachment.contentId !== undefined;
	const name = attachment.filename;
	const headers: [string, string][] = [
		[
			'Content-Type',
			name === undefined ? type : `${type}; ${parameter('name', name)}`,
		],
		['Content-Transfer-Encoding', 'base64'],
		[
			'Content-Disposition',
			`${inline ? 'inline' : 'attachment'}${name === undefined ? '' : `; ${parameter('filename', name)}`}`,
		],
	];
	if (inline) headers.push(['Content-ID', `<${attachment.contentId}>`]);
	return { headers, body: encodeBase64(content) };
}

function multipart(subtype: string, parts: readonly Part[]): Part {
	if (parts.length === 1) return parts[0] as Part;
	const mark = boundary();
	const body = `${parts
		.map((part) => `--${mark}\r\n${render(part)}`)
		.join('\r\n')}\r\n--${mark}--`;
	return {
		headers: [['Content-Type', `multipart/${subtype}; boundary="${mark}"`]],
		body,
	};
}

/** An unstructured value, encoded; a line break in it is refused before encoding could hide it. */
function unstructured(name: string, value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new MimeError(
			'INVALID_OPTION',
			`The value of ${name} holds a line break`,
		);
	}
	return encodeHeaderValue(value);
}

function render(part: Part): string {
	return `${part.headers.map(([name, value]) => foldHeader(name, value)).join('\r\n')}\r\n\r\n${part.body}`;
}

/**
 * Writes a message (RFC 5322, MIME): its header fields, then its body as a
 * single part or as `multipart/alternative` (text and HTML),
 * `multipart/related` (inline images) and `multipart/mixed` (attachments),
 * nested as mail clients expect. The result is 7-bit ASCII with CRLF line
 * breaks, ready for SMTP: non-ASCII text is quoted-printable, files are
 * base64, and header values are encoded-words. Bcc is never written.
 */
export function buildMessage(options: MessageOptions): string {
	const from = toMailbox(options.from);
	const domain = from.address.slice(from.address.lastIndexOf('@') + 1);
	const fields: [string, string][] = [
		['Date', formatDate(options.date ?? new Date())],
		['From', formatMailbox(from)],
	];
	if (options.sender !== undefined)
		fields.push(['Sender', formatMailbox(toMailbox(options.sender))]);
	const addresses = (name: string, input: MessageOptions['to']) => {
		const mailboxes = list(input).map(toMailbox);
		if (mailboxes.length > 0)
			fields.push([name, mailboxes.map(formatMailbox).join(', ')]);
	};
	addresses('To', options.to);
	addresses('Cc', options.cc);
	addresses('Reply-To', options.replyTo);
	if (options.subject !== undefined)
		fields.push(['Subject', unstructured('Subject', options.subject)]);
	fields.push([
		'Message-ID',
		`<${options.messageId ?? `${crypto.randomUUID()}@${domain}`}>`,
	]);
	if (options.inReplyTo !== undefined)
		fields.push(['In-Reply-To', `<${options.inReplyTo}>`]);
	if (options.references?.length) {
		fields.push([
			'References',
			options.references.map((id) => `<${id}>`).join(' '),
		]);
	}
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		fields.push([name, unstructured(name, value)]);
	}
	fields.push(['MIME-Version', '1.0']);

	const bodies: Part[] = [];
	if (options.text !== undefined) bodies.push(textPart(options.text, 'plain'));
	if (options.html !== undefined) bodies.push(textPart(options.html, 'html'));
	if (bodies.length === 0) bodies.push(textPart('', 'plain'));
	let body = multipart('alternative', bodies);

	const attachments = options.attachments ?? [];
	const inline = attachments.filter((a) => a.contentId !== undefined);
	const files = attachments.filter((a) => a.contentId === undefined);
	if (inline.length > 0)
		body = multipart('related', [body, ...inline.map(attachmentPart)]);
	if (files.length > 0)
		body = multipart('mixed', [body, ...files.map(attachmentPart)]);

	return render({ headers: [...fields, ...body.headers], body: body.body });
}
