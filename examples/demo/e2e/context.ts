/**
 * What every step of the e2e shares: the run's report, the demo it talks
 * to, the CA its TLS checks trust, the password, and the helpers for
 * writing a message and reading IMAP's replies.
 */
import type { DemoInfo } from '../src/demo';
import { SENDER_DOMAIN } from '../src/dns';
import { ImapClient } from './imap-client';
import type { Report } from './report';

export interface E2e {
	readonly report: Report;
	readonly info: DemoInfo;
	/** The fixture certificate, trusted by every TLS check. */
	readonly ca: string;
	/** A short id that makes this run's subjects unique. */
	readonly run: string;
	/** alice's password, given to the demo. */
	readonly password: string;
}

export const ALICE = 'alice@example.test';
export const BOB = `bob@${SENDER_DOMAIN}`;

export function message(
	from: string,
	to: string,
	subject: string,
	body: string,
): string {
	return [
		`From: <${from}>`,
		`To: <${to}>`,
		`Subject: ${subject}`,
		`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
		`Message-ID: <${crypto.randomUUID()}@${from.slice(from.indexOf('@') + 1)}>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		body,
		'',
	].join('\r\n');
}

/** An IMAP session on the implicit-TLS port, logged in as alice, INBOX selected. */
export async function login(e2e: E2e): Promise<ImapClient> {
	const imap = await ImapClient.connectTls(e2e.info.ports.imaps, e2e.ca);
	const greeting = await imap.line();
	if (!greeting.startsWith('* OK')) throw new Error(`greeting: ${greeting}`);
	const logged = await imap.command(`LOGIN alice "${e2e.password}"`);
	if (!logged.ok) throw new Error(`LOGIN: ${logged.status}`);
	const selected = await imap.command('SELECT INBOX');
	if (!selected.ok) throw new Error(`SELECT: ${selected.status}`);
	return imap;
}

/** The sequence numbers of a SEARCH's `* SEARCH` line. */
export function searched(lines: readonly string[]): number[] {
	const line = lines.find((each) => each.startsWith('* SEARCH'));
	return (line ?? '')
		.slice('* SEARCH'.length)
		.trim()
		.split(' ')
		.filter(Boolean)
		.map(Number);
}
