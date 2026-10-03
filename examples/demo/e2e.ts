#!/usr/bin/env bun
/**
 * The demo, end to end: starts Mailpit (unless it runs) and the demo, then
 * checks, over real sockets, inbound mail into IMAP, IDLE, submission out
 * to Mailpit with a DKIM signature, that nothing relays, and the IMAP
 * operations a mail client uses. Prints a PASS/FAIL table, stops the demo,
 * stops Mailpit if it started it, and exits 1 on any failure.
 *
 *   bun run demo:e2e     (from the repository root; builds first)
 */
import { importDkimPrivateKey, signDkim, verifyDkim } from '@bumail/auth';
import { fixtureResolver } from '@bumail/dns';
import { SmtpError, sendMail } from '@bumail/smtp/client';
import { type DemoProcess, spawnDemo } from './e2e/demo-process';
import { ImapClient } from './e2e/imap-client';
import { ensureMailpit, findMessage, stopMailpit } from './e2e/mailpit';
import { Report } from './e2e/report';
import { SmtpProbe } from './e2e/smtp-probe';
import type { DemoInfo } from './src/demo';
import { SENDER_DOMAIN, SENDER_PRIVATE_KEY, SENDER_SELECTOR } from './src/dns';
import { fixtureTls } from './src/tls';

const report = new Report();
const ca = (await fixtureTls()).cert;
const run = crypto.randomUUID().slice(0, 8);
const password = `e2e-${crypto.randomUUID().slice(0, 12)}`;
const ALICE = 'alice@example.test';
const BOB = `bob@${SENDER_DOMAIN}`;

function message(from: string, to: string, subject: string, body: string) {
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

/** An IMAP session on 993, logged in as alice, INBOX selected. */
async function login(info: DemoInfo): Promise<ImapClient> {
	const imap = await ImapClient.connectTls(info.ports.imaps, ca);
	const greeting = await imap.line();
	if (!greeting.startsWith('* OK')) throw new Error(`greeting: ${greeting}`);
	const logged = await imap.command(`LOGIN alice "${password}"`);
	if (!logged.ok) throw new Error(`LOGIN: ${logged.status}`);
	const selected = await imap.command('SELECT INBOX');
	if (!selected.ok) throw new Error(`SELECT: ${selected.status}`);
	return imap;
}

/** The sequence numbers of a SEARCH's `* SEARCH` line. */
function searched(lines: readonly string[]): number[] {
	const line = lines.find((each) => each.startsWith('* SEARCH'));
	return (line ?? '')
		.slice('* SEARCH'.length)
		.trim()
		.split(' ')
		.filter(Boolean)
		.map(Number);
}

async function inbound(info: DemoInfo, imap: ImapClient): Promise<void> {
	const subject = `e2e inbound ${run}`;
	const text = message(BOB, ALICE, subject, `Hello Alice, run ${run}.`);
	const signature = await signDkim(text, {
		domain: SENDER_DOMAIN,
		selector: SENDER_SELECTOR,
		privateKey: await importDkimPrivateKey(SENDER_PRIVATE_KEY),
	});
	const sent = await sendMail(signature + text, {
		host: 'localhost',
		port: info.ports.mx,
		from: BOB,
		to: ALICE,
	});
	report.check(
		'sendMail to :2525 accepted',
		sent.accepted.length === 1,
		`${sent.reply.code} ${sent.reply.text}`,
	);

	// INBOX was selected before the delivery: NOOP is how a client hears of it.
	const noop = await imap.command('NOOP');
	report.check(
		'NOOP reports * n EXISTS',
		noop.untagged.some((line) => /^\* \d+ EXISTS$/.test(line)),
		noop.untagged.join(' '),
	);
	const found = await imap.command(`SEARCH SUBJECT "${subject}"`);
	const [number] = searched(found.untagged);
	if (
		!report.check(
			'SEARCH finds it in INBOX',
			number !== undefined,
			found.untagged.join(' '),
		)
	) {
		return;
	}
	const fetched = await imap.command(
		`FETCH ${number} (ENVELOPE BODY.PEEK[HEADER.FIELDS (RECEIVED AUTHENTICATION-RESULTS)] BODY.PEEK[])`,
	);
	const response = fetched.untagged.join('\n');
	report.check('FETCH OK', fetched.ok, fetched.status);
	report.check(
		'ENVELOPE has subject and sender',
		/ENVELOPE \(/.test(response) &&
			response.includes(`"${subject}"`) &&
			response.includes('(NIL NIL "bob" "sender.test")') &&
			response.includes('(NIL NIL "alice" "example.test")'),
		/ENVELOPE \([^\r\n]*/.exec(response)?.[0] ?? response.slice(0, 200),
	);
	report.check(
		'BODY[] has the text',
		response.includes(`Hello Alice, run ${run}.`),
	);
	const received = /Received: from [^\r\n]*\r?\n?[^\r\n]*by localhost/i.exec(
		response,
	);
	report.check(
		'Received added by the MX',
		received !== null,
		received?.[0] ?? '',
	);
	const results =
		/Authentication-Results: localhost;[\s\S]*?(?=\r\n[^\s])/i.exec(
			response,
		)?.[0] ?? '';
	report.check(
		'Authentication-Results: spf=pass',
		/spf=pass/.test(results),
		results,
	);
	report.check(
		'Authentication-Results: dkim=pass d=sender.test',
		/dkim=pass header\.d=sender\.test/.test(results),
		results,
	);
}

async function idle(info: DemoInfo): Promise<void> {
	const watcher = await login(info);
	try {
		const session = await watcher.idle();
		const started = Date.now();
		await sendMail(message(BOB, ALICE, `e2e idle ${run}`, 'Wake up.'), {
			host: 'localhost',
			port: info.ports.mx,
			from: BOB,
			to: ALICE,
		});
		let exists = '';
		while (Date.now() - started < 2000) {
			const line = await watcher.line(
				Math.max(1, 2000 - (Date.now() - started)),
			);
			if (/^\* \d+ EXISTS$/.test(line)) {
				exists = line;
				break;
			}
		}
		const elapsed = Date.now() - started;
		report.check(
			'* n EXISTS within 2 s',
			exists !== '',
			`${exists} after ${elapsed} ms`,
		);
		const done = await session.done();
		report.check('DONE ends IDLE', done.ok, done.status);
	} finally {
		watcher.close();
	}
}

async function submission(info: DemoInfo): Promise<void> {
	const subject = `e2e submission ${run}`;
	const to = 'someone@elsewhere.test';
	const sent = await sendMail(message(ALICE, to, subject, 'Out it goes.'), {
		host: 'localhost',
		port: info.ports.submission,
		from: ALICE,
		to,
		auth: { username: 'alice', password },
		ca,
	});
	report.check(
		'STARTTLS, certificate checked',
		sent.tls !== false && sent.tls.verified,
		JSON.stringify(sent.tls),
	);
	report.check('AUTH accepted', sent.authenticated === true);
	report.check(
		'message accepted',
		sent.accepted.length === 1,
		`${sent.reply.code} ${sent.reply.text}`,
	);

	const raw = await findMessage(subject);
	if (!report.check('reached Mailpit (API)', raw !== undefined, subject))
		return;
	const header =
		/^DKIM-Signature:[\s\S]*?(?=\r?\n[^\s])/im.exec(raw ?? '')?.[0] ?? '';
	report.check(
		'DKIM-Signature present, d=example.test',
		/d=example\.test/.test(header),
		header,
	);
	const resolver = fixtureResolver({
		[info.dkim.name]: { txt: [info.dkim.record] },
	});
	const [verified] = await verifyDkim(raw ?? '', { resolver });
	report.check(
		'DKIM-Signature verifies',
		verified?.result === 'pass',
		`${verified?.result} ${verified?.reason ?? ''}`,
	);
}

async function noRelay(info: DemoInfo): Promise<void> {
	// 2525 without AUTH, to a domain the demo does not host.
	try {
		await sendMail(message(BOB, 'victim@elsewhere.test', 'relay?', 'No.'), {
			host: 'localhost',
			port: info.ports.mx,
			from: BOB,
			to: 'victim@elsewhere.test',
		});
		report.check(':2525 refuses relaying', false, 'the message was accepted');
	} catch (error) {
		const reply =
			error instanceof SmtpError ? error.rejected?.[0]?.reply : undefined;
		report.check(
			':2525 refuses relaying',
			error instanceof SmtpError &&
				error.code === 'RECIPIENTS_REFUSED' &&
				reply?.code === 554,
			reply ? `${reply.code} ${reply.text}` : `${error}`,
		);
	}
	// An unknown local user.
	try {
		await sendMail(message(BOB, 'nobody@example.test', 'who?', 'Nobody.'), {
			host: 'localhost',
			port: info.ports.mx,
			from: BOB,
			to: 'nobody@example.test',
		});
		report.check(':2525 refuses an unknown user', false, 'accepted');
	} catch (error) {
		const reply =
			error instanceof SmtpError ? error.rejected?.[0]?.reply : undefined;
		report.check(
			':2525 refuses an unknown user',
			reply?.code === 550,
			reply ? `${reply.code} ${reply.text}` : `${error}`,
		);
	}

	// 2587 in clear: no AUTH offered, AUTH refused, MAIL refused.
	const probe = await SmtpProbe.connect(info.ports.submission);
	try {
		await probe.reply();
		const ehlo = await probe.send('EHLO e2e.test');
		report.check(
			':2587 clear EHLO offers STARTTLS',
			ehlo.some((line) => /^250[- ]STARTTLS$/.test(line)),
			ehlo.join(' | '),
		);
		report.check(
			':2587 clear EHLO offers no AUTH',
			!ehlo.some((line) => /^250[- ]AUTH\b/.test(line)),
			ehlo.join(' | '),
		);
		const credentials = Buffer.from(`\0alice\0${password}`).toString('base64');
		const auth = await probe.send(`AUTH PLAIN ${credentials}`);
		report.check(
			':2587 AUTH in clear refused',
			/^5\d\d/.test(auth[0] ?? ''),
			auth.join(' '),
		);
		const mail = await probe.send(`MAIL FROM:<${ALICE}>`);
		report.check(
			':2587 MAIL without AUTH refused',
			/^5\d\d/.test(mail[0] ?? ''),
			mail.join(' '),
		);
		const tls = await probe.send('STARTTLS');
		report.check(
			':2587 STARTTLS',
			tls[0]?.startsWith('220') === true,
			tls.join(' '),
		);
		await probe.startTls(ca);
		const secure = await probe.send('EHLO e2e.test');
		report.check(
			':2587 EHLO after TLS offers AUTH',
			secure.some((line) => /^250[- ]AUTH\b/.test(line)),
			secure.join(' | '),
		);
		const relay = await probe.send('MAIL FROM:<bob@sender.test>');
		report.check(
			':2587 MAIL after TLS, before AUTH, refused',
			/^5\d\d/.test(relay[0] ?? ''),
			relay.join(' '),
		);
		await probe.send('QUIT').catch(() => []);
	} finally {
		probe.close();
	}

	// 1143: LOGINDISABLED in clear, LOGIN after STARTTLS.
	const imap = await ImapClient.connectPlain(info.ports.imap);
	try {
		await imap.line();
		const before = await imap.command('CAPABILITY');
		const caps = before.untagged.join(' ');
		report.check(
			':1143 clear: STARTTLS, LOGINDISABLED',
			caps.includes('STARTTLS') && caps.includes('LOGINDISABLED'),
			caps,
		);
		const clear = await imap.command(`LOGIN alice "${password}"`);
		report.check(
			':1143 LOGIN in clear refused',
			clear.status.includes('NO'),
			clear.status,
		);
		const started = await imap.command('STARTTLS');
		await imap.upgrade(ca);
		const after = await imap.command('CAPABILITY');
		report.check(
			':1143 STARTTLS',
			started.ok && !after.untagged.join(' ').includes('LOGINDISABLED'),
			after.untagged.join(' '),
		);
		const logged = await imap.command(`LOGIN alice "${password}"`);
		report.check(':1143 LOGIN after STARTTLS', logged.ok, logged.status);
		await imap.command('LOGOUT');
	} finally {
		imap.close();
	}
}

async function operations(imap: ImapClient): Promise<void> {
	const list = await imap.command('LIST "" "*" RETURN (SPECIAL-USE)');
	const lines = list.untagged.join('\n');
	report.check(
		'LIST RETURN (SPECIAL-USE)',
		list.ok &&
			['\\Sent', '\\Drafts', '\\Archive', '\\Junk', '\\Trash'].every((use) =>
				lines.includes(use),
			),
		lines,
	);

	const subject = `e2e append ${run}`;
	const appended = await imap.command(
		'APPEND INBOX (\\Flagged)',
		message(ALICE, ALICE, subject, 'Appended by the e2e.'),
	);
	report.check('APPEND', appended.ok, appended.status);
	await imap.command('NOOP');

	const [number] = searched(
		(await imap.command(`SEARCH SUBJECT "${subject}"`)).untagged,
	);
	if (!report.check('SEARCH SUBJECT finds the APPEND', number !== undefined))
		return;

	const stored = await imap.command(`STORE ${number} +FLAGS (\\Seen)`);
	const flags = stored.untagged.join(' ');
	report.check(
		'STORE +FLAGS \\Seen',
		stored.ok && flags.includes('\\Seen') && flags.includes('\\Flagged'),
		flags,
	);
	const seen = searched((await imap.command('SEARCH SEEN')).untagged);
	report.check('SEARCH SEEN', seen.includes(number as number), seen.join(' '));
	const unseen = searched((await imap.command('SEARCH UNSEEN')).untagged);
	report.check(
		'SEARCH UNSEEN excludes it',
		!unseen.includes(number as number),
		unseen.join(' '),
	);

	const copied = await imap.command(`COPY ${number} Archive`);
	report.check('COPY to Archive', copied.ok, copied.status);

	const deleted = await imap.command(`STORE ${number} +FLAGS (\\Deleted)`);
	const expunged = await imap.command('EXPUNGE');
	report.check(
		'EXPUNGE',
		deleted.ok &&
			expunged.ok &&
			expunged.untagged.includes(`* ${number} EXPUNGE`),
		expunged.untagged.join(' '),
	);
	const gone = searched(
		(await imap.command(`SEARCH SUBJECT "${subject}"`)).untagged,
	);
	report.check(
		'EXPUNGEd message gone from INBOX',
		gone.length === 0,
		gone.join(' '),
	);

	const [idled] = searched(
		(await imap.command(`SEARCH SUBJECT "e2e idle ${run}"`)).untagged,
	);
	const moved = await imap.command(`MOVE ${idled} Archive`);
	report.check(
		'MOVE to Archive',
		moved.ok && moved.untagged.includes(`* ${idled} EXPUNGE`),
		`${moved.status} ${moved.untagged.join(' ')}`,
	);

	const archive = await imap.command('SELECT Archive');
	const exists = archive.untagged.find((line) => / EXISTS$/.test(line));
	report.check(
		'Archive holds both',
		exists === '* 2 EXISTS',
		exists ?? archive.status,
	);
	const [copy] = searched(
		(await imap.command(`SEARCH SUBJECT "${subject}" SEEN FLAGGED`)).untagged,
	);
	report.check('the COPY kept its flags', copy !== undefined);
	await imap.command('LOGOUT');
}

let demo: DemoProcess | undefined;
let startedMailpit = false;
try {
	await report.step('0 setup', async () => {
		startedMailpit = await ensureMailpit();
		report.check(
			'Mailpit on :1025/:8025',
			true,
			startedMailpit ? 'started by this run' : 'already running',
		);
		demo = await spawnDemo(password);
		report.check('demo started', true, demo.info.directory);
	});
	const info = demo?.info;
	if (info !== undefined) {
		let imap: ImapClient | undefined;
		await report.step('1 inbound', async () => {
			imap = await login(info);
			report.check('IMAP :1993 LOGIN, SELECT INBOX', true);
			await inbound(info, imap);
		});
		await report.step('2 idle', () => idle(info));
		await report.step('3 submission', () => submission(info));
		await report.step('4 no open relay', () => noRelay(info));
		await report.step('5 imap ops', async () => {
			imap ??= await login(info);
			await operations(imap);
		});
		(imap as ImapClient | undefined)?.close();
	}
} finally {
	await demo?.stop();
	if (startedMailpit) await stopMailpit();
}

report.print();
if (!report.passed && demo !== undefined) {
	console.log('\nThe demo printed:');
	for (const line of demo.output) console.log(`  ${line}`);
}
process.exit(report.passed ? 0 : 1);
