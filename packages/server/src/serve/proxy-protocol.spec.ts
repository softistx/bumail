import { afterEach, describe, expect, test } from 'bun:test';
import { type Fixture, LineClient, startServer } from './serve.fixtures';

let fixture: Fixture | undefined;

afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
});

const TRUSTED = '[proxyProtocol]\ntrusted = ["127.0.0.1", "::1"]';

/** A PROXY protocol v1 header for a client at 203.0.113.7. */
const HEADER = 'PROXY TCP4 203.0.113.7 192.0.2.1 51000 25\r\n';

/** PROXY protocol v2's header (HAProxy's spec, §2.2) for a client at 42.7.7.7: every byte under 0x80, so a string carries it. */
function v2(): string {
	const signature = [
		0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
	];
	const addresses = [42, 7, 7, 7, 10, 0, 0, 1, 0x12, 0x34, 0x00, 0x19];
	return String.fromCharCode(
		...[
			...signature,
			0x21, // version 2, PROXY
			0x11, // TCP over IPv4
			0,
			addresses.length,
			...addresses,
		],
	);
}

describe('[proxyProtocol]', () => {
	test('is off by default: a PROXY line is no header, and the connection is the client', async () => {
		fixture = await startServer();
		const client = await LineClient.connect(fixture.port('submission'));
		client.write(HEADER);
		expect(await client.reply()).toStartWith('220');
		client.end();
	});

	test('reaches the SMTP servers: a header from a trusted proxy sets the client address', async () => {
		fixture = await startServer(TRUSTED);
		const client = await LineClient.connect(fixture.port('submission'));
		client.write(HEADER);
		expect(await client.reply()).toStartWith('220');
		await client.smtp('EHLO client.example');
		expect(await client.smtp('STARTTLS')).toStartWith('220');
		await client.startTls();
		await client.smtp('EHLO client.example');
		const wrong = Buffer.from('\0alice@example.com\0not it').toString('base64');
		expect(await client.smtp(`AUTH PLAIN ${wrong}`)).toStartWith('535');
		client.end();
		expect(fixture.lines).toContain(
			'submission: login refused from 203.0.113.7: password',
		);
	});

	test('takes version 2 too, on the mail port 25', async () => {
		fixture = await startServer(TRUSTED);
		const client = await LineClient.connect(fixture.port('mx'));
		client.write(v2());
		expect(await client.reply()).toStartWith('220');
		await client.smtp('EHLO client.example');
		await client.smtp('MAIL FROM:<joe@reject.example>');
		await client.smtp('RCPT TO:<alice@example.com>');
		await client.smtp('DATA');
		client.write(
			'From: <joe@reject.example>\r\nSubject: x\r\n\r\nHi.\r\n.\r\n',
		);
		await client.reply();
		client.end();
		await Bun.sleep(50);
		expect(fixture.lines.join('\n')).toContain(
			'from 42.7.7.7 <joe@reject.example>',
		);
	});

	test('reaches the IMAP servers: the header comes before the TLS handshake on 993', async () => {
		fixture = await startServer(TRUSTED);
		const client = await LineClient.connect(fixture.port('imaps'));
		client.write(HEADER);
		await client.startTls();
		expect(await client.until(/^\* OK[^\n]*\n/)).toStartWith('* OK');
		expect(await client.imap('a1', 'LOGIN alice@example.com "not it"')).toMatch(
			/a1 NO/,
		);
		client.end();
		expect(fixture.lines).toContain(
			'imaps: login refused from 203.0.113.7: password',
		);
	});

	test('does not trust a peer it does not list: its header is not read', async () => {
		fixture = await startServer('[proxyProtocol]\ntrusted = ["10.9.9.9"]');
		const client = await LineClient.connect(fixture.port('submission'));
		expect(await client.reply()).toStartWith('220');
		// A command like any other, and not one: no header was read.
		expect(await client.smtp(HEADER.trimEnd())).toStartWith('5');
		client.end();
	});
});
