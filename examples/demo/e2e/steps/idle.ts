/** Step 2: a second session in IDLE hears of a delivery within 2 s. */
import { sendMail } from '@bumail/smtp/client';
import { ALICE, BOB, type E2e, login, message } from '../context';
import type { ImapClient } from '../imap-client';

export async function idle(e2e: E2e): Promise<void> {
	const { report, info, run } = e2e;
	const watcher = await login(e2e);
	try {
		const session = await watcher.idle();
		const started = Date.now();
		await sendMail(message(BOB, ALICE, `e2e idle ${run}`, 'Wake up.'), {
			host: 'localhost',
			port: info.ports.mx,
			from: BOB,
			to: ALICE,
		});
		const exists = await nextExists(watcher, started, 2000);
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

/** The first `* n EXISTS` line before `ms` after `started`, or `''`. */
async function nextExists(
	imap: ImapClient,
	started: number,
	ms: number,
): Promise<string> {
	while (Date.now() - started < ms) {
		const line = await imap.line(Math.max(1, ms - (Date.now() - started)));
		if (/^\* \d+ EXISTS$/.test(line)) return line;
	}
	return '';
}
