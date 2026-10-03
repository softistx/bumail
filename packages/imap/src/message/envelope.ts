import {
	type Address,
	encodeHeaderValue,
	type MessageHeaders,
	type Mailbox as MimeMailbox,
	parseAddressList,
} from '@bumail/mime';
import type { Response } from '../protocol/response';

/** Text sent in 7 bits: encoded-words (RFC 2047) for what is not ASCII. */
export function ascii(text: string): string {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7e) return encodeHeaderValue(text);
	}
	return text;
}

function addresses(value: string | undefined): Address[] {
	if (value === undefined || value.trim() === '') return [];
	try {
		return parseAddressList(value);
	} catch {
		return [];
	}
}

/** A local part without the quotes RFC 5322 needed to write it. */
function unquoted(local: string): string {
	if (local.length < 2 || !local.startsWith('"') || !local.endsWith('"'))
		return local;
	return local.slice(1, -1).replace(/\\(.)/g, '$1');
}

function mailbox(out: Response, { name, address }: MimeMailbox): void {
	const at = address.lastIndexOf('@');
	out
		.text('(')
		.nstring(name === '' ? undefined : ascii(name))
		.text(' NIL ');
	if (at < 0) out.string(unquoted(address)).text(' "MISSING_DOMAIN")');
	else {
		out
			.string(unquoted(address.slice(0, at)))
			.text(' ')
			.string(address.slice(at + 1))
			.text(')');
	}
}

/** An address list as ENVELOPE writes it (RFC 9051 §7.5.2): groups opened and closed by markers. */
function addressList(out: Response, list: readonly Address[]): void {
	if (list.length === 0) {
		out.text('NIL');
		return;
	}
	out.text('(');
	for (const address of list) {
		if ('group' in address) {
			out.text('(NIL NIL ').string(ascii(address.group)).text(' NIL)');
			for (const member of address.members) mailbox(out, member);
			out.text('(NIL NIL NIL NIL)');
		} else mailbox(out, address);
	}
	out.text(')');
}

/**
 * ENVELOPE (RFC 9051 §7.5.2): date, subject, from, sender, reply-to, to,
 * cc, bcc, in-reply-to and message-id. Fields go as written, unfolded;
 * sender and reply-to default to from. Display names are decoded by the
 * address parser, then sent back as encoded-words when they are not ASCII.
 */
export function envelope(out: Response, headers: MessageHeaders): void {
	const from = addresses(headers.get('from'));
	const sender = addresses(headers.get('sender'));
	const replyTo = addresses(headers.get('reply-to'));
	out
		.text('(')
		.nstring(headers.get('date'))
		.text(' ')
		.nstring(headers.get('subject'))
		.text(' ');
	addressList(out, from);
	out.text(' ');
	addressList(out, sender.length > 0 ? sender : from);
	out.text(' ');
	addressList(out, replyTo.length > 0 ? replyTo : from);
	for (const name of ['to', 'cc', 'bcc']) {
		out.text(' ');
		addressList(out, addresses(headers.get(name)));
	}
	out
		.text(' ')
		.nstring(headers.get('in-reply-to'))
		.text(' ')
		.nstring(headers.get('message-id'))
		.text(')');
}

/** The envelope of a message that could not be read: every field NIL. */
export const EMPTY_ENVELOPE = '(NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL)';
