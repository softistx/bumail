import {
	encodeHeaderValue,
	encodeQuotedPrintable,
	foldHeader,
	formatDate,
} from '@bumail/mime';
import { cleanText, replaceControls } from '../text';
import { returned } from './content';
import {
	type DsnKind,
	type DsnRecipient,
	deliveryStatus,
	statusOf,
} from './fields';

export type { DsnKind, DsnRecipient } from './fields';

/** What a DSN says, about which message, to whom. */
export interface DsnInput {
	readonly kind: DsnKind;
	/** This server's public name: the Reporting-MTA, and the Message-ID's domain. */
	readonly reportingMta: string;
	/** The DSN's From: the postmaster's address. */
	readonly from: string;
	/** The original's sender, to whom the DSN goes. */
	readonly to: string;
	/** When the original was enqueued. */
	readonly arrival: Date;
	/** When the DSN is written. */
	readonly date: Date;
	readonly recipients: readonly DsnRecipient[];
	/** With `delayed`: when the queue gives up. */
	readonly willRetryUntil?: Date;
	/** The original message, as enqueued. */
	readonly original: Uint8Array;
	readonly returnContent: 'headers' | 'full';
	/** The most bytes of the original returned. */
	readonly maxReturn: number;
}

const encoder = new TextEncoder();
const strip = (text: string) =>
	replaceControls(text, '').replace(/[\s<>]/g, '');

/** The text a person reads first: what happened, to whom, and why (RFC 3464 §2's first part). */
function humanText(input: DsnInput): string {
	const failed = input.kind === 'failed';
	const lines = failed
		? [
				`This is the mail system at ${input.reportingMta}.`,
				'',
				'Your message could not be delivered to the recipients below.',
				'This is a permanent failure: the message will not be retried.',
			]
		: [
				`This is the mail system at ${input.reportingMta}.`,
				'',
				'Your message has not been delivered yet to the recipients below.',
				'This is a warning only: the message is still being retried',
				...(input.willRetryUntil
					? [`until ${formatDate(input.willRetryUntil)}.`]
					: []),
				'You do not need to send it again.',
			];
	lines.push('');
	for (const r of input.recipients) {
		const said = r.reply
			? `${r.reply.code ?? ''} ${cleanText(r.reply.text, 900)}`.trim()
			: statusOf(input.kind);
		const why =
			r.reply?.status === '4.4.7'
				? `delivery time expired, still failing: ${said}`
				: said;
		lines.push(`<${cleanText(r.address, 254)}>: ${why}`);
	}
	return `${lines.join('\r\n')}\r\n`;
}

/** The header fields of the DSN, every value cleaned and folded. */
function headerFields(input: DsnInput, boundary: string): string[] {
	const subject =
		input.kind === 'failed'
			? 'Undelivered Mail Returned to Sender'
			: 'Delayed Mail (still being retried)';
	const domain = strip(input.reportingMta);
	return [
		foldHeader('Date', formatDate(input.date)),
		foldHeader('From', `Mail Delivery System <${strip(input.from)}>`),
		foldHeader('To', `<${strip(input.to)}>`),
		foldHeader('Subject', encodeHeaderValue(subject)),
		foldHeader('Message-ID', `<${crypto.randomUUID()}@${domain}>`),
		// RFC 3834 §5: an automatic answer, which no one answers automatically.
		foldHeader('Auto-Submitted', 'auto-replied'),
		foldHeader('MIME-Version', '1.0'),
		foldHeader(
			'Content-Type',
			`multipart/report; report-type=delivery-status; boundary="${boundary}"`,
		),
	];
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/** A boundary that occurs nowhere in what it separates. */
function boundaryFor(content: Uint8Array): string {
	const text = new TextDecoder('latin1').decode(content);
	for (;;) {
		const boundary = `=_dsn_${crypto.randomUUID()}`;
		if (!text.includes(boundary)) return boundary;
	}
}

/**
 * A delivery status notification (RFC 3464): a `multipart/report`
 * (RFC 6522) of `report-type=delivery-status` holding the text a person
 * reads, the `message/delivery-status` fields a program reads, and the
 * original's header fields (or the whole original, when asked and small
 * enough), bounded by `maxReturn`. Nothing from the remote server or the
 * envelope reaches a header field raw: control characters, CR and LF are
 * taken out first.
 */
export function buildDsn(input: DsnInput): Uint8Array {
	const original = returned(
		input.original,
		input.returnContent,
		input.maxReturn,
	);
	const boundary = boundaryFor(original.body);
	const text = encodeQuotedPrintable(humanText(input));
	const status = deliveryStatus({
		kind: input.kind,
		reportingMta: input.reportingMta,
		arrival: input.arrival,
		recipients: input.recipients,
		...(input.willRetryUntil ? { willRetryUntil: input.willRetryUntil } : {}),
	});
	const head = [
		...headerFields(input, boundary),
		'',
		'This is a MIME-formatted delivery status notification.',
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		text,
		`--${boundary}`,
		'Content-Type: message/delivery-status',
		'',
		status,
		`--${boundary}`,
		`Content-Type: ${original.type}`,
		...(original.eightBit ? ['Content-Transfer-Encoding: 8bit'] : []),
		'',
		'',
	].join('\r\n');
	return concat([
		encoder.encode(head),
		original.body,
		encoder.encode(`\r\n--${boundary}--\r\n`),
	]);
}
