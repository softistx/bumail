import { describe, expect, test } from 'bun:test';
import { createSmtpServer } from './server';
import { FAKE_TLS, fakeSession, mxOptions } from './session.fixtures';

const transaction =
	'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n';

describe('STARTTLS (RFC 3207)', () => {
	test('220, then TLS, then the session starts over: EHLO again (§4.2)', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('STARTTLS\r\n')).toBe(
			'220 2.0.0 Ready to start TLS\r\n',
		);
		expect(s.tlsStarts).toBe(1);
		expect(s.connection.session).toMatchObject({ secure: true, esmtp: false });
		expect(s.connection.session.helo).toBeUndefined();
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toBe(
			'503 Send EHLO first\r\n',
		);
	});

	test('commands pipelined behind STARTTLS in clear are dropped, never run (CVE-2011-0411)', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\n');
		expect(
			await s.send('STARTTLS\r\nMAIL FROM:<injected@evil.example>\r\nNOOP\r\n'),
		).toBe('220 2.0.0 Ready to start TLS\r\n');
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
	});

	test('not offered without tls; not twice', async () => {
		const clear = await fakeSession(mxOptions());
		await clear.send('EHLO bar.com\r\n');
		expect(await clear.send('STARTTLS\r\n')).toBe(
			'454 4.7.0 TLS not available\r\n',
		);
		const secure = await fakeSession(mxOptions({ tls: FAKE_TLS }), {
			secure: true,
		});
		await secure.send('EHLO bar.com\r\n');
		expect(await secure.send('STARTTLS\r\n')).toBe(
			'503 5.5.1 TLS already active\r\n',
		);
	});

	test('the transaction in progress is forgotten', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nSTARTTLS\r\n');
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
	});
});

describe('SMTP smuggling', () => {
	test('a message with a bare LF is refused: 550 5.6.11, nothing delivered', async () => {
		const s = await fakeSession(mxOptions());
		await s.send(transaction);
		const out = await s.send(
			'Subject: hi\r\n\r\nx\n.\nMAIL FROM:<admin@foo.com>\r\nRCPT TO:<victim@foo.com>\r\nDATA\r\nforged\r\n.\r\n',
		);
		expect(out).toBe(
			'550 5.6.11 Bare CR or LF is not allowed in a message\r\n',
		);
		expect(s.received).toHaveLength(0);
	});

	test('a bare CR as well', async () => {
		const s = await fakeSession(mxOptions());
		await s.send(transaction);
		expect(await s.send('a\rb\r\n.\r\n')).toStartWith('550 5.6.11');
	});
});

describe('limits', () => {
	test('maxMessageSize: the message is read to its end, then refused with 552 5.3.4', async () => {
		const s = await fakeSession(mxOptions({ maxMessageSize: 10 }));
		await s.send(transaction);
		expect(await s.send(`${'x'.repeat(100)}\r\n.\r\n`)).toBe(
			'552 5.3.4 Message too big for system\r\n',
		);
		expect(await s.send('NOOP\r\n')).toBe('250 2.0.0 OK\r\n');
		expect(s.received).toHaveLength(0);
	});

	test('a message of exactly maxMessageSize is taken', async () => {
		const s = await fakeSession(mxOptions({ maxMessageSize: 5 }));
		await s.send(transaction);
		expect(await s.send('abc\r\n.\r\n')).toStartWith('250');
	});

	test('maxRecipients: 452 4.5.3 past it (RFC 5321 §4.5.3.1.10)', async () => {
		const s = await fakeSession(mxOptions({ maxRecipients: 2 }));
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nRCPT TO:<c@foo.com>\r\n',
		);
		expect(await s.send('RCPT TO:<d@foo.com>\r\n')).toBe(
			'452 4.5.3 Too many recipients\r\n',
		);
	});

	test('maxErrors: the server hangs up with 421', async () => {
		const s = await fakeSession(mxOptions({ maxErrors: 3 }));
		await s.send('EHLO bar.com\r\nBOGUS\r\nBOGUS\r\n');
		expect(await s.send('BOGUS\r\n')).toBe(
			'421 4.7.0 foo.com Too many errors, closing\r\n',
		);
		expect(s.ended).toBe(true);
		expect(await s.send('NOOP\r\n')).toBe('');
	});

	test('a command line over 2048 bytes: 500 5.5.6, and the rest of it is skipped', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(await s.send(`NOOP ${'x'.repeat(3000)}`)).toBe(
			'500 5.5.6 Line too long\r\n',
		);
		expect(await s.send(`${'x'.repeat(3000)}\r\nNOOP\r\n`)).toBe(
			'250 2.0.0 OK\r\n',
		);
	});
});

describe('options', () => {
	test.each([
		[
			{ hostname: 'bad name' },
			'createSmtpServer(): "bad name" is not a host name',
		],
		[
			{ implicitTls: true },
			'createSmtpServer(): implicitTls needs tls: { key, cert }',
		],
		[
			{ maxRecipients: 0 },
			'createSmtpServer(): maxRecipients must be a positive integer, not 0',
		],
		[
			{ timeout: 1.5 },
			'createSmtpServer(): timeout must be a positive integer, not 1.5',
		],
		[
			{ maxMessageSize: Number.NaN },
			'createSmtpServer(): maxMessageSize must be a positive integer, not NaN',
		],
	])('%o is refused', (overrides, message) => {
		expect(() => createSmtpServer(mxOptions(overrides))).toThrow(message);
	});
});
