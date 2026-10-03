#!/usr/bin/env bun
/**
 * The bumail demo: an MX on 2525, submission on 2587, IMAP on 1143
 * (STARTTLS) and 1993 (TLS), one sqlite store, one user. Local only, with
 * a self-signed certificate for `localhost`: never a production server.
 *
 *   bun run build && bun run demo     (from the repository root)
 *
 * Settings come from the environment: DEMO_PASSWORD, DEMO_DIR, DEMO_BIND,
 * DEMO_MX_PORT, DEMO_SUBMISSION_PORT, DEMO_IMAP_PORT, DEMO_IMAPS_PORT,
 * SMARTHOST_HOST and SMARTHOST_PORT. See README.md.
 */
import { readConfig } from './src/config';
import { startDemo } from './src/demo';

const time = () => new Date().toISOString().slice(11, 19);
const demo = await startDemo(readConfig(), (line) =>
	console.log(`${time()} ${line}`),
);
const { info } = demo;

console.log(`
bumail demo — local only, self-signed certificate for localhost

  user        ${info.address}   (or just: alice)
  password    ${info.password}

  IMAP        localhost:${info.ports.imaps}  SSL/TLS
              localhost:${info.ports.imap}  STARTTLS
  SMTP        localhost:${info.ports.submission}  STARTTLS, AUTH (submission)
  MX          localhost:${info.ports.mx}  mail for @example.test, no relay
  smarthost   ${info.smarthost.host}:${info.smarthost.port}
  store       ${info.directory}${info.temporary ? '  (removed on exit; set DEMO_DIR to keep it)' : ''}
  DKIM        ${info.dkim.name} TXT "${info.dkim.record}"

Ctrl-C to stop.
`);
// One line for a script to read: the e2e waits for it.
console.log(`DEMO READY ${JSON.stringify(info)}`);

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	await demo.stop();
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
