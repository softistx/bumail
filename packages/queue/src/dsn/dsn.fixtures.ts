import { parseHeaderBlock, parseMessage } from '@bumail/mime';
import type { DsnInput } from './build';
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export const ORIGINAL =
	'From: Mary <mary@example.net>\r\nTo: joe@example.com\r\nSubject: Lunch\r\nMessage-ID: <1@example.net>\r\n\r\nSee you at noon.\r\n';

export const at = (iso: string) => new Date(iso);

export function input(overrides: Partial<DsnInput> = {}): DsnInput {
	return {
		kind: 'failed',
		reportingMta: 'mail.example.net',
		from: 'postmaster@example.net',
		to: 'mary@example.net',
		arrival: at('2026-10-01T12:00:00Z'),
		date: at('2026-10-01T12:05:00Z'),
		recipients: [
			{
				address: 'joe@example.com',
				reply: {
					code: 550,
					status: '5.1.1',
					text: 'Requested action not taken: mailbox unavailable',
					host: 'mx.example.com',
				},
				lastAttempt: at('2026-10-01T12:05:00Z'),
			},
		],
		original: encoder.encode(ORIGINAL),
		returnContent: 'headers',
		maxReturn: 64 * 1024,
		...overrides,
	};
}

export const parse = (dsn: Uint8Array) => parseMessage(dsn);
export const fieldsOf = (text: string) =>
	text
		.trim()
		.split(/\r\n\r\n/)
		.map((block) => parseHeaderBlock(encoder.encode(`${block}\r\n\r\n`)));
