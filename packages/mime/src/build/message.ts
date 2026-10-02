import { MimeError } from '../errors';
import { formatMailbox } from '../headers/addresses';
import { formatDate } from '../headers/date';
import { encodeHeaderValue } from '../headers/encoded-words';
import { list, toMailbox, toMailboxes } from './envelope';
import type { MessageOptions } from './options';
import {
	attachmentPart,
	checkId,
	multipart,
	type Part,
	render,
	textPart,
} from './parts';

/** The fields `buildMessage` writes itself, which `headers` may not repeat. */
const RESERVED = new Set([
	'from',
	'sender',
	'to',
	'cc',
	'bcc',
	'reply-to',
	'subject',
	'date',
	'message-id',
	'in-reply-to',
	'references',
	'mime-version',
]);

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

/**
 * Writes a message (RFC 5322, MIME): its header fields, then its body as a
 * single part or as `multipart/alternative` (text and HTML),
 * `multipart/related` (inline images) and `multipart/mixed` (attachments),
 * nested as mail clients expect. The result is 7-bit ASCII with CRLF line
 * breaks, ready for SMTP: non-ASCII text is quoted-printable, files are
 * base64, and header values are encoded-words. Bcc is never written, but
 * its addresses are checked like the others.
 */
export function buildMessage(options: MessageOptions): string {
	const caller = 'buildMessage()';
	const from = toMailbox(options.from, caller);
	for (const input of list(options.bcc)) toMailboxes(input, caller);
	const domain = from.address.slice(from.address.lastIndexOf('@') + 1);
	const fields: [string, string][] = [
		['Date', formatDate(options.date ?? new Date())],
		['From', formatMailbox(from)],
	];
	if (options.sender !== undefined) {
		fields.push(['Sender', formatMailbox(toMailbox(options.sender, caller))]);
	}
	const addresses = (name: string, input: MessageOptions['to']) => {
		const mailboxes = list(input).flatMap((item) => toMailboxes(item, caller));
		if (mailboxes.length > 0)
			fields.push([name, mailboxes.map(formatMailbox).join(', ')]);
	};
	addresses('To', options.to);
	addresses('Cc', options.cc);
	addresses('Reply-To', options.replyTo);
	if (options.subject !== undefined) {
		fields.push(['Subject', unstructured('Subject', options.subject)]);
	}
	const messageId = options.messageId ?? `${crypto.randomUUID()}@${domain}`;
	fields.push(['Message-ID', `<${checkId(messageId, 'messageId')}>`]);
	if (options.inReplyTo !== undefined) {
		fields.push([
			'In-Reply-To',
			`<${checkId(options.inReplyTo, 'inReplyTo')}>`,
		]);
	}
	if (options.references?.length) {
		fields.push([
			'References',
			options.references
				.map((id) => `<${checkId(id, 'references')}>`)
				.join(' '),
		]);
	}
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		const key = name.toLowerCase();
		if (RESERVED.has(key) || key.startsWith('content-')) {
			throw new MimeError(
				'INVALID_OPTION',
				`headers: ${name} is written by buildMessage; set it through its own option`,
			);
		}
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
