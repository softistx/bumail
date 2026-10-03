/**
 * Step 3: alice submits a message for an outside address after STARTTLS
 * and AUTH; it reaches Mailpit, DKIM-signed for example.test.
 */
import { verifyDkim } from '@bumail/auth';
import { fixtureResolver } from '@bumail/dns';
import { sendMail } from '@bumail/smtp/client';
import { ALICE, type E2e, message } from '../context';
import { findMessage } from '../mailpit';

export async function submission({
	report,
	info,
	ca,
	run,
	password,
}: E2e): Promise<void> {
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
		`:${info.ports.submission} STARTTLS, certificate checked`,
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
