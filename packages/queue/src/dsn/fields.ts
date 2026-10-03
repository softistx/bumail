import { foldHeader, formatDate } from '@bumail/mime';
import type { Diagnostic } from '../contract/types';
import { asciiText, replaceControls } from '../text';

/** One recipient a DSN reports on. */
export interface DsnRecipient {
	readonly address: string;
	readonly reply?: Diagnostic;
	/** When it was last tried. */
	readonly lastAttempt: Date;
}

export type DsnKind = 'delayed' | 'failed';

/** What a delivery-status part reports: who reports, on what, and each recipient. */
export interface StatusReport {
	readonly kind: DsnKind;
	/** This server's name. */
	readonly reportingMta: string;
	/** When the message was enqueued. */
	readonly arrival: Date;
	readonly recipients: readonly DsnRecipient[];
	/** With `delayed`: when the queue gives up. */
	readonly willRetryUntil?: Date;
}

/** Control characters out, CR and LF first: nothing from outside starts a field of its own. */
const strip = (text: string) => replaceControls(text, '');

/** The longest escaped address: with its field name, within 998 characters a line. */
const MAX_ESCAPED = 900;

/**
 * An address as a delivery-status field types it: `rfc822; addr` when it
 * is ASCII; otherwise `utf-8;` with each non-ASCII character as
 * `\x{HEX}` (RFC 6533 §3, utf-8-addr-xtext), so the part stays 7-bit,
 * cut at 900 characters so it always fits a header line.
 */
export function typedAddress(address: string): string {
	const clean = strip(address).replace(/[\s\\]/g, '');
	if (/^[\x21-\x7e]*$/.test(clean)) return `rfc822; ${clean}`;
	let escaped = '';
	for (const c of clean) {
		const piece = /[\x21-\x7e]/.test(c)
			? c
			: `\\x{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
		// One word, so it must fit a line (RFC 5322 §2.1.1): cut, never lost.
		if (escaped.length + piece.length > MAX_ESCAPED) break;
		escaped += piece;
	}
	return `utf-8; ${escaped}`;
}

/** A host name as `dns; host`, or nothing when it is not one. */
const remoteMta = (host: string | undefined) =>
	host && /^[A-Za-z0-9.:[\]-]{1,255}$/.test(host) ? `dns; ${host}` : undefined;

/**
 * The status (RFC 3463) of a recipient: the reply's enhanced code; else
 * its class from the reply code; else, with nothing at all, the kind's.
 */
export function statusOf(kind: DsnKind, reply?: Diagnostic): string {
	if (reply?.status) return reply.status;
	if (reply?.code !== undefined) {
		return reply.code >= 500 ? '5.0.0' : '4.0.0';
	}
	return kind === 'failed' ? '5.0.0' : '4.0.0';
}

/** The fields of one recipient (RFC 3464 §2.3), folded, no line from outside. */
function recipientFields(
	report: StatusReport,
	recipient: DsnRecipient,
): string[] {
	const { reply } = recipient;
	const fields: [string, string][] = [
		['Final-Recipient', typedAddress(recipient.address)],
		['Action', report.kind],
		['Status', statusOf(report.kind, reply)],
	];
	const remote = remoteMta(reply?.host);
	if (remote) fields.push(['Remote-MTA', remote]);
	if (reply) {
		const text = asciiText(reply.text, 900);
		fields.push(
			reply.code === undefined
				? ['Diagnostic-Code', `X-Bumail; ${text}`]
				: ['Diagnostic-Code', `smtp; ${reply.code} ${text}`],
		);
	}
	fields.push(['Last-Attempt-Date', formatDate(recipient.lastAttempt)]);
	if (report.kind === 'delayed' && report.willRetryUntil) {
		fields.push(['Will-Retry-Until', formatDate(report.willRetryUntil)]);
	}
	return fields.map(([name, value]) => foldHeader(name, value));
}

/**
 * The body of a `message/delivery-status` part (RFC 3464 §2.1): the
 * per-message fields, then each recipient's, a blank line between, CRLF.
 */
export function deliveryStatus(report: StatusReport): string {
	const message = [
		foldHeader('Reporting-MTA', `dns; ${strip(report.reportingMta)}`),
		foldHeader('Arrival-Date', formatDate(report.arrival)),
	].join('\r\n');
	const blocks = report.recipients.map((r) =>
		recipientFields(report, r).join('\r\n'),
	);
	return `${[message, ...blocks].join('\r\n\r\n')}\r\n`;
}
