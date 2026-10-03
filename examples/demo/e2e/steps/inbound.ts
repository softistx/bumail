/**
 * Step 1: a DKIM-signed message to the MX for alice, then read back over
 * IMAP — NOOP, SEARCH, FETCH of the envelope, the body, and the fields the
 * MX added.
 */
import { importDkimPrivateKey, signDkim } from '@bumail/auth';
import { sendMail } from '@bumail/smtp/client';
import {
	SENDER_DOMAIN,
	SENDER_PRIVATE_KEY,
	SENDER_SELECTOR,
} from '../../src/dns';
import { ALICE, BOB, type E2e, message, searched } from '../context';
import type { ImapClient } from '../imap-client';

export async function inbound(e2e: E2e, imap: ImapClient): Promise<void> {
	const { report, info, run } = e2e;
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
		`sendMail to :${info.ports.mx} accepted`,
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
	await fetched(e2e, imap, number as number, subject);
}

/** FETCH of what the client shows and what the MX added. */
async function fetched(
	{ report, run }: E2e,
	imap: ImapClient,
	number: number,
	subject: string,
): Promise<void> {
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
