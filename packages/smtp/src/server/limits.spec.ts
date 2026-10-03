import { describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import { createSmtpServer } from './server';
import { FAKE_TLS, fakeSession, mxOptions } from './session.fixtures';

const transaction =
	'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n';

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
		// The server's own close: it never waits on a client that stopped reading.
		expect(s.aborted).toBe(true);
		expect(await s.send('NOOP\r\n')).toBe('');
	});

	test('content pipelined after a refused DATA is dropped, never run as commands', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('DATA\r\nRSET\r\nMAIL FROM:<x@evil.example>\r\n')).toBe(
			'554 5.5.1 No valid recipients\r\n',
		);
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe('250 2.1.5 OK\r\n');
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
		[
			{ hookTimeout: 0 },
			'createSmtpServer(): hookTimeout must be a positive integer, not 0',
		],
		[
			{ hookTimeout: 2_147_484 },
			'createSmtpServer(): hookTimeout must be at most 2147483 seconds, not 2147484',
		],
		[
			{ greetingDelay: -1 },
			'createSmtpServer(): greetingDelay must be a number of seconds, 0 or more, not -1',
		],
		[
			{ greetingDelay: 300 },
			'createSmtpServer(): greetingDelay (300 s) must be shorter than timeout (300 s), or every client times out before the greeting',
		],
		[
			{ hostname: undefined as unknown as string },
			'createSmtpServer(): "undefined" is not a host name',
		],
		[
			{ authenticate: () => true },
			'createSmtpServer(): authenticate needs tls: { key, cert }, since AUTH is offered only once encrypted',
		],
		[
			{ localDomains: 'foo.com' as unknown as string[] },
			'createSmtpServer(): localDomains must be an array of domains or a function',
		],
		[
			{ localDomains: [1] as unknown as string[] },
			'createSmtpServer(): localDomains must be an array of domains or a function',
		],
		[
			{ onData: undefined as unknown as () => undefined },
			'createSmtpServer(): onData must be a function: it is where messages go',
		],
	])('%o is refused', (overrides, message) => {
		expect(() => createSmtpServer(mxOptions(overrides))).toThrow(message);
	});

	test('hookTimeout up to 2147483 seconds is taken', () => {
		expect(() =>
			createSmtpServer(mxOptions({ hookTimeout: 2_147_483 })),
		).not.toThrow();
	});

	test('the error is an SmtpError with code INVALID_OPTION', () => {
		try {
			createSmtpServer(mxOptions({ maxErrors: -1 }));
			throw new Error('not refused');
		} catch (error) {
			expect(error).toBeInstanceOf(SmtpError);
			expect((error as SmtpError).code).toBe('INVALID_OPTION');
		}
	});

	test('submission with authenticate and tls is taken', () => {
		expect(() =>
			createSmtpServer(
				mxOptions({
					mode: 'submission',
					tls: FAKE_TLS,
					authenticate: () => true,
				}),
			),
		).not.toThrow();
	});
});
