#!/usr/bin/env bun
/**
 * A mail client run inside a container of the e2e's network, so that the
 * server sees an address of its own (not the Docker gateway) as the client.
 * Prints one JSON line.
 *
 *   client.ts submit <host> <port> <user> <password> <from> <to> <subject>
 *   client.ts deliver <host> <port> <from> <to> <subject>     (port 25, no AUTH)
 *   client.ts badlogin <host> <port> <user>                    (a wrong password on submission)
 */
import { Smtp } from './protocols';

const [op, host = '', portText = '0', ...rest] = process.argv.slice(2);
const port = Number(portText);
const SERVERNAME = process.env['E2E_HOSTNAME'] ?? 'mail.bumail.test';

async function session(): Promise<Smtp> {
	const { smtp, greeting } = await Smtp.connect(host, port, {
		servername: SERVERNAME,
	});
	if (greeting.code !== 220) throw new Error(greeting.lines.join(' / '));
	await smtp.command(`EHLO client.bumail.test`);
	const tlsAnswer = await smtp.startTls(SERVERNAME);
	if (tlsAnswer.code !== 220) throw new Error(tlsAnswer.lines.join(' / '));
	await smtp.command('EHLO client.bumail.test');
	return smtp;
}

const message = (from: string, to: string, subject: string) =>
	[
		`From: <${from}>`,
		`To: <${to}>`,
		`Subject: ${subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@client.bumail.test>`,
		'',
		`Sent by the e2e client: ${subject}`,
	].join('\r\n');

let result: unknown;
if (op === 'submit') {
	const [user = '', password = '', from = '', to = '', subject = ''] = rest;
	const smtp = await session();
	const auth = await smtp.authPlain(user, password);
	const sent =
		auth.code === 235
			? await smtp.send(from, to, message(from, to, subject))
			: auth;
	await smtp.quit();
	result = { auth: auth.code, sent: sent.code, lines: sent.lines };
} else if (op === 'deliver') {
	const [from = '', to = '', subject = ''] = rest;
	const smtp = await session();
	const sent = await smtp.send(from, to, message(from, to, subject));
	await smtp.quit();
	result = { sent: sent.code, lines: sent.lines };
} else if (op === 'badlogin') {
	const [user = ''] = rest;
	const smtp = await session();
	const auth = await smtp.authPlain(user, 'not-the-password');
	await smtp.quit();
	result = { auth: auth.code, lines: auth.lines };
} else {
	throw new Error(`unknown operation ${op}`);
}
console.log(JSON.stringify(result));
