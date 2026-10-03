#!/usr/bin/env bun
/**
 * Sends one DKIM-signed message to a local Mailpit, to see the client work
 * end to end against a server that is not this package's own: the message,
 * its headers and its DKIM-Signature show in Mailpit's web UI.
 *
 * It signs with `@bumail/auth`'s `signDkim` and a throwaway Ed25519 key
 * made for the run (RFC 8463), and prints the DNS record that would
 * publish it. No DNS is asked: Mailpit checks nothing, so the signature
 * only shows what a signed message looks like.
 *
 * It lives beside the package rather than under the root `scripts/`: the
 * root scripts are the repository's own tooling (build, publish, verify),
 * and import no package; this one uses two, as an app would.
 *
 *   docker run --rm -p 8025:8025 -p 1025:1025 axllent/mailpit
 *   bun run build
 *   bun packages/smtp/examples/try-mailpit.ts [--host localhost] [--port 1025]
 *     [--from sender@example.com] [--to you@example.org]
 *
 * Or by the environment: MAILPIT_HOST, MAILPIT_PORT, MAIL_FROM, MAIL_TO.
 * Then open http://localhost:8025.
 */
import { signDkim } from '@bumail/auth';
import { SmtpError, sendMail } from '@bumail/smtp/client';

/** `--name value` from the arguments, else the environment variable, else the default. */
function setting(name: string, env: string, fallback: string): string {
	const at = Bun.argv.indexOf(`--${name}`);
	const given = at > 0 ? Bun.argv[at + 1] : undefined;
	return given ?? Bun.env[env] ?? fallback;
}

const host = setting('host', 'MAILPIT_HOST', 'localhost');
const port = Number(setting('port', 'MAILPIT_PORT', '1025'));
const from = setting('from', 'MAIL_FROM', 'sender@example.com');
const to = setting('to', 'MAIL_TO', 'you@example.org');
const domain = from.slice(from.lastIndexOf('@') + 1);

const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
	'sign',
	'verify',
])) as CryptoKeyPair;
const publicKey = new Uint8Array(
	await crypto.subtle.exportKey('raw', keys.publicKey),
).toBase64();

const message = [
	`From: Bumail <${from}>`,
	`To: <${to}>`,
	'Subject: Hello from @bumail/smtp/client',
	`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
	`Message-ID: <${crypto.randomUUID()}@${domain}>`,
	'MIME-Version: 1.0',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'This message was signed with a throwaway Ed25519 key and sent by sendMail.',
	'',
].join('\r\n');

const signature = await signDkim(message, {
	domain,
	selector: 'try',
	privateKey: keys.privateKey,
});

try {
	const result = await sendMail(signature + message, { host, port, from, to });
	console.log(`  sent      ${from} → ${to} via ${result.host}:${result.port}`);
	console.log(`  reply     ${result.reply.code} ${result.reply.text}`);
	console.log(
		`  tls       ${result.tls ? 'yes' : 'no (Mailpit offers none by default)'}`,
	);
	console.log(
		`  dkim      try._domainkey.${domain} TXT "v=DKIM1; k=ed25519; p=${publicKey}"`,
	);
	console.log('\nOpen Mailpit, on port 8025 of the same host, to see it.');
} catch (error) {
	if (!(error instanceof SmtpError)) throw error;
	console.error(`  FAIL      ${error.code}: ${error.message}`);
	if (error.code === 'CONNECTION_FAILED') {
		console.error(
			'\nIs Mailpit running? docker run --rm -p 8025:8025 -p 1025:1025 axllent/mailpit',
		);
	}
	process.exit(1);
}
