#!/usr/bin/env bun
/**
 * The demo, end to end: starts Mailpit (unless it runs) and the demo, then
 * checks, over real sockets, inbound mail into IMAP, IDLE, submission out
 * to Mailpit with a DKIM signature, that nothing relays, and the IMAP
 * operations a mail client uses. Prints a PASS/FAIL table, stops the demo,
 * stops Mailpit if it started it, and exits 1 on any failure.
 *
 * The steps are in `e2e/steps/`; this file only runs them in order.
 *
 *   bun run demo:e2e     (from the repository root; builds first)
 */
import { type E2e, login } from './e2e/context';
import { type DemoProcess, spawnDemo } from './e2e/demo-process';
import type { ImapClient } from './e2e/imap-client';
import { ensureMailpit, MAILPIT_API, stopMailpit } from './e2e/mailpit';
import { Report } from './e2e/report';
import { idle } from './e2e/steps/idle';
import { imapOps } from './e2e/steps/imap-ops';
import { inbound } from './e2e/steps/inbound';
import { noRelay } from './e2e/steps/no-relay';
import { submission } from './e2e/steps/submission';
import { fixtureTls } from './src/tls';

const report = new Report();
const password = `e2e-${crypto.randomUUID().slice(0, 12)}`;

let demo: DemoProcess | undefined;
let startedMailpit = false;
try {
	await report.step('0 setup', async () => {
		startedMailpit = await ensureMailpit();
		report.check(
			`Mailpit API on :${new URL(MAILPIT_API).port}`,
			true,
			startedMailpit ? 'started by this run' : 'already running',
		);
		demo = await spawnDemo(password);
		const { ports, smarthost, directory } = demo.info;
		report.check(
			'demo started',
			true,
			`ports ${Object.values(ports).join(', ')}, smarthost :${smarthost.port}, ${directory}`,
		);
	});
	if (demo !== undefined) await steps(demo);
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

async function steps(demo: DemoProcess): Promise<void> {
	const e2e: E2e = {
		report,
		info: demo.info,
		ca: (await fixtureTls()).cert,
		run: crypto.randomUUID().slice(0, 8),
		password,
	};
	let imap: ImapClient | undefined;
	await report.step('1 inbound', async () => {
		imap = await login(e2e);
		report.check(`IMAP :${e2e.info.ports.imaps} LOGIN, SELECT INBOX`, true);
		await inbound(e2e, imap);
	});
	await report.step('2 idle', () => idle(e2e));
	await report.step('3 submission', () => submission(e2e));
	await report.step('4 no open relay', () => noRelay(e2e));
	await report.step('5 imap ops', async () => {
		imap ??= await login(e2e);
		await imapOps(e2e, imap);
	});
	(imap as ImapClient | undefined)?.close();
}
