import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import type { SmtpServer } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import { seededDirectory } from '../directory/directory.fixtures';
import { judge } from './inbound';
import { createMx } from './mx';
import { message, RECORDS, sendMail } from './serve.fixtures';
import { Spool, type Spooled } from './spool';

let spool: Spool | undefined;
let server: SmtpServer | undefined;
let directory: Directory | undefined;
/** Every file `spooledOf` spooled: removed even when an expect failed, so no open file outlives its test. */
const spooledFiles: Spooled[] = [];

afterEach(async () => {
	await Promise.all(spooledFiles.splice(0).map((spooled) => spooled.remove()));
	server?.stop(true);
	directory?.close();
	spool?.close();
	server = undefined;
	directory = undefined;
	spool = undefined;
});

/** Over 64 KiB of body: more than one read of the spooled file. */
const LARGE = `${'x'.repeat(76)}\r\n`.repeat(2000);

/** `text`, spooled through a real spool, as the MX listener spools it. */
async function spooledOf(text: string): Promise<Spooled> {
	spool = Spool.open(tempDir(), 1 << 24);
	const written = await spool.write(
		'm',
		new Blob([new TextEncoder().encode(text)]).stream(),
	);
	if (written === 'full') throw new Error('full');
	spooledFiles.push(written);
	return written;
}

/** The verdict of `enforce` on `spooled`, read back through its open file. */
function judged(spooled: Spooled) {
	const { header } = spooled;
	if (header === undefined) throw new Error('no header');
	return judge({ header, whole: () => spooled.stream() }, undefined, {
		hostname: 'mail.example.com',
		resolver: fixtureResolver(RECORDS),
		mode: 'enforce',
	});
}

const fromReject = (headers = '') =>
	`${headers}From: <joe@reject.example>\r\nSubject: large\r\n\r\n${LARGE}`;

describe('checks over 64 KiB, read back from the spool', () => {
	test('an unsigned message from a p=reject domain is still refused', async () => {
		const spooled = await spooledOf(fromReject());
		const verdict = await judged(spooled);
		expect(verdict.dkim.map((d) => d.result)).toEqual(['none']);
		expect(verdict.dmarc.result).toBe('fail');
		expect(verdict.action).toBe('reject');
	});

	test('a message whose signature cannot be used is still refused', async () => {
		const signature =
			'DKIM-Signature: v=1; a=rsa-sha256; d=reject.example; s=gone; h=from; bh=AAAA; b=AAAA\r\n';
		const spooled = await spooledOf(fromReject(signature));
		const verdict = await judged(spooled);
		expect(verdict.dkim.map((d) => d.result)).not.toContain('temperror');
		expect(verdict.dkim.map((d) => d.result)).not.toContain('pass');
		expect(verdict.action).toBe('reject');
	});

	test.each([
		['an unsupported version', 'v=2; a=rsa-sha256'],
		['rsa-sha1', 'v=1; a=rsa-sha1'],
	])(
		'a signature refused before any key lookup (%s) is still refused',
		async (_, tags) => {
			// No key to wait for: DKIM stops reading the body at once. That early
			// stop is not a read that failed, so the message is refused, not deferred.
			const signature = `DKIM-Signature: ${tags}; d=reject.example; s=sel; h=from; bh=AAAA; b=AAAA\r\n`;
			const spooled = await spooledOf(fromReject(signature));
			const verdict = await judged(spooled);
			expect(verdict.dkim.map((d) => d.result)).toEqual(['permerror']);
			expect(verdict.dmarc.result).toBe('fail');
			expect(verdict.action).toBe('reject');
		},
	);

	test('a file that can no longer be read still defers', async () => {
		const signature =
			'DKIM-Signature: v=1; a=rsa-sha256; d=reject.example; s=gone; h=from; bh=AAAA; b=AAAA\r\n';
		const spooled = await spooledOf(fromReject(signature));
		// Closed under the check: every read of it fails.
		await spooled.remove();
		const verdict = await judged(spooled);
		expect(verdict.dkim.map((d) => d.result)).toEqual(['temperror']);
		expect(verdict.action).toBe('defer');
	});
});

test('a delivery over 64 KiB stores exactly the bytes sent', async () => {
	directory = await seededDirectory();
	const store = new MemoryMailStore();
	spool = Spool.open(tempDir(), 1 << 24);
	server = createMx({
		hostname: 'mail.example.com',
		directory,
		store,
		resolver: fixtureResolver(RECORDS),
		inbound: {
			dmarc: 'enforce',
			maxMessageSize: 1 << 20,
			maxConnections: 10,
			spoolBytes: 1 << 24,
		},
		tls: await selfSigned(['localhost']),
		spool,
		log: () => {},
		describe: (error) =>
			error instanceof Error ? error.message : String(error),
		onDelivered: () => {},
		track: (work) => work,
	});
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const text = message('joe@pass.example', 'large') + LARGE;
	const { last } = await sendMail(
		port,
		{ from: 'joe@pass.example', to: ['alice@example.com'] },
		text,
	);
	expect(last).toStartWith('250 ');
	const account = await store.findAccount('alice@example.com');
	if (account === undefined) throw new Error('no account');
	const inbox = await store.findMailbox(account.id, 'inbox');
	if (inbox === undefined) throw new Error('no INBOX');
	const [stored] = await store.listMessages(account.id, inbox.id);
	if (stored === undefined) throw new Error('nothing stored');
	const blob = await store.readContent(account.id, stored.message.blobId);
	const mail = (await blob?.text()) ?? '';
	// What the client sent: the text, and the line end before its final dot.
	const sent = `${text}\r\n`;
	const start = mail.indexOf('From: <joe@pass.example>');
	expect(start).toBeGreaterThan(0);
	expect(mail.slice(start)).toBe(sent);
	expect(mail.slice(0, start)).toStartWith('Return-Path: <joe@pass.example>');
});
