/**
 * Step 4: nothing relays and nothing authenticates in clear — the MX
 * refuses outside domains and unknown users, submission offers and takes
 * AUTH only after STARTTLS, and IMAP takes LOGIN only after STARTTLS.
 */
import { SmtpError, sendMail } from '@bumail/smtp/client';
import { ALICE, BOB, type E2e, message } from '../context';
import { ImapClient } from '../imap-client';
import { SmtpProbe } from '../smtp-probe';

export async function noRelay(e2e: E2e): Promise<void> {
	await mxProbe(e2e);
	await submissionProbe(e2e);
	await imapProbe(e2e);
}

/** The MX without AUTH: an outside domain (554), an unknown local user (550). */
async function mxProbe({ report, info }: E2e): Promise<void> {
	const port = info.ports.mx;
	const refuses = async (name: string, to: string, code: number) => {
		try {
			await sendMail(message(BOB, to, name, 'No.'), {
				host: 'localhost',
				port,
				from: BOB,
				to,
			});
			report.check(name, false, 'the message was accepted');
		} catch (error) {
			const reply =
				error instanceof SmtpError ? error.rejected?.[0]?.reply : undefined;
			report.check(
				name,
				error instanceof SmtpError &&
					error.code === 'RECIPIENTS_REFUSED' &&
					reply?.code === code,
				reply ? `${reply.code} ${reply.text}` : `${error}`,
			);
		}
	};
	await refuses(`:${port} refuses relaying`, 'victim@elsewhere.test', 554);
	await refuses(`:${port} refuses an unknown user`, 'nobody@example.test', 550);
}

/** Submission in clear: no AUTH offered, AUTH and MAIL refused, until TLS and AUTH. */
async function submissionProbe({
	report,
	info,
	ca,
	password,
}: E2e): Promise<void> {
	const at = `:${info.ports.submission}`;
	const probe = await SmtpProbe.connect(info.ports.submission);
	const refused = (lines: string[]) => /^5\d\d/.test(lines[0] ?? '');
	try {
		await probe.reply();
		const ehlo = await probe.send('EHLO e2e.test');
		report.check(
			`${at} clear EHLO offers STARTTLS`,
			ehlo.some((line) => /^250[- ]STARTTLS$/.test(line)),
			ehlo.join(' | '),
		);
		report.check(
			`${at} clear EHLO offers no AUTH`,
			!ehlo.some((line) => /^250[- ]AUTH\b/.test(line)),
			ehlo.join(' | '),
		);
		const credentials = Buffer.from(`\0alice\0${password}`).toString('base64');
		const auth = await probe.send(`AUTH PLAIN ${credentials}`);
		report.check(`${at} AUTH in clear refused`, refused(auth), auth.join(' '));
		const mail = await probe.send(`MAIL FROM:<${ALICE}>`);
		report.check(
			`${at} MAIL without AUTH refused`,
			refused(mail),
			mail.join(' '),
		);
		const tls = await probe.send('STARTTLS');
		report.check(
			`${at} STARTTLS`,
			tls[0]?.startsWith('220') === true,
			tls.join(' '),
		);
		await probe.startTls(ca);
		const secure = await probe.send('EHLO e2e.test');
		report.check(
			`${at} EHLO after TLS offers AUTH`,
			secure.some((line) => /^250[- ]AUTH\b/.test(line)),
			secure.join(' | '),
		);
		const relay = await probe.send(`MAIL FROM:<${BOB}>`);
		report.check(
			`${at} MAIL after TLS, before AUTH, refused`,
			refused(relay),
			relay.join(' '),
		);
		await probe.send('QUIT').catch(() => []);
	} finally {
		probe.close();
	}
}

/** IMAP in clear: LOGINDISABLED and LOGIN refused, then STARTTLS and LOGIN. */
async function imapProbe({ report, info, ca, password }: E2e): Promise<void> {
	const at = `:${info.ports.imap}`;
	const imap = await ImapClient.connectPlain(info.ports.imap);
	try {
		await imap.line();
		const before = await imap.command('CAPABILITY');
		const caps = before.untagged.join(' ');
		report.check(
			`${at} clear: STARTTLS, LOGINDISABLED`,
			caps.includes('STARTTLS') && caps.includes('LOGINDISABLED'),
			caps,
		);
		const clear = await imap.command(`LOGIN alice "${password}"`);
		report.check(
			`${at} LOGIN in clear refused`,
			clear.status.includes('NO'),
			clear.status,
		);
		const started = await imap.command('STARTTLS');
		await imap.upgrade(ca);
		const after = await imap.command('CAPABILITY');
		report.check(
			`${at} STARTTLS`,
			started.ok && !after.untagged.join(' ').includes('LOGINDISABLED'),
			after.untagged.join(' '),
		);
		const logged = await imap.command(`LOGIN alice "${password}"`);
		report.check(`${at} LOGIN after STARTTLS`, logged.ok, logged.status);
		await imap.command('LOGOUT');
	} finally {
		imap.close();
	}
}
