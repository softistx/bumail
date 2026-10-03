import { afterEach, describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import { type FakeScript, fakeServer, stopServers } from './client.fixtures';
import type { SendMailEnvelope } from './options';
import { sendMail } from './send';

afterEach(stopServers);

const MESSAGE = 'Subject: hi\r\n\r\nhello\r\n';

/** Sends to a fake server; what it rejected with, and the lines the server was sent. */
async function against(
	script: FakeScript,
	options: Partial<SendMailEnvelope> = {},
	message: Parameters<typeof sendMail>[0] = MESSAGE,
): Promise<{ error: SmtpError; lines: string[] }> {
	const { port, lines } = await fakeServer(script);
	const error = await sendMail(message, {
		host: '127.0.0.1',
		port,
		from: 'a@bar.com',
		to: 'b@foo.com',
		...options,
	}).then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(SmtpError);
	return { error: error as SmtpError, lines };
}

describe('a hostile or broken server ends in an SmtpError, never a hang or a throw of Bun’s', () => {
	test('a huge line', async () => {
		const { error } = await against({ greeting: `220 ${'x'.repeat(100_000)}` });
		expect(error).toMatchObject({ code: 'BAD_REPLY', temporary: true });
		expect(error.message).toBe(
			'127.0.0.1 sent a reply line longer than 2048 bytes',
		);
	});

	test('an endless multiline reply', async () => {
		const { error } = await against({
			greeting: '220-more\r\n'.repeat(10_000),
		});
		expect(error.message).toBe('127.0.0.1 sent a reply of more than 100 lines');
	});

	test('replies past the budget', async () => {
		const flood = '250 x\r\n'.repeat(200_000);
		const slow = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await Bun.sleep(300);
				controller.enqueue(
					new TextEncoder().encode('Subject: x\r\n\r\nslow\r\n'),
				);
				controller.close();
			},
		});
		const { error } = await against(
			{
				command: (line) => (line === 'DATA' ? `354 go\r\n${flood}` : undefined),
			},
			{},
			slow,
		);
		expect(error.message).toBe(
			'127.0.0.1 sent more than 1048576 bytes of replies',
		);
	});

	test('garbage, and a reply whose lines change code', async () => {
		const garbage = await against({ greeting: 'hello there\r\n' });
		expect(garbage.error.message).toBe(
			'127.0.0.1 sent a line that is not an SMTP reply: "hello there"',
		);
		const mixed = await against({ greeting: '220-a\r\n250 b\r\n' });
		expect(mixed.error.message).toBe(
			'127.0.0.1 sent a reply whose lines change code, from 220 to 250',
		);
	});

	test('silence: the greeting’s timeout, then the deadline', async () => {
		const silent: FakeScript = { connected: () => true };
		const timeout = await against(silent, { timeouts: { greeting: 0.2 } });
		expect(timeout.error).toMatchObject({ code: 'TIMEOUT', temporary: true });
		expect(timeout.error.message).toBe(
			'Timed out after 0.2 s waiting for the greeting (127.0.0.1)',
		);
		const deadline = await against(silent, { deadline: 0.2 });
		expect(deadline.error.message).toBe(
			'The deadline of 0.2 s passed waiting for the greeting (127.0.0.1)',
		);
	});

	test('a server that stops reading the message: the data block’s timeout', async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(0x61);
		let sent = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ > 512) return controller.close();
				controller.enqueue(chunk);
			},
		});
		const { error, lines } = await against(
			{
				command: (line, socket) => {
					if (line !== 'DATA') return undefined;
					socket.pause();
					return '354 go\r\n';
				},
			},
			{ timeouts: { dataBlock: 0.3 } },
			endless,
		);
		expect(error.message).toBe(
			'Timed out after 0.3 s waiting for the server to take the message (127.0.0.1)',
		);
		expect(lines.some((line) => line.startsWith('<message'))).toBe(false);
	});

	test('a connection closed half-way', async () => {
		const { error } = await against({
			command: (line) => (line.startsWith('MAIL') ? null : undefined),
		});
		expect(error).toMatchObject({ code: 'CONNECTION_LOST', temporary: true });
		expect(error.message).toBe(
			'The connection to 127.0.0.1 closed before the reply to MAIL FROM',
		);
	});

	test('a reply smuggled after the 220 to STARTTLS (CVE-2011-0411)', async () => {
		const { error } = await against({
			ehlo: ['STARTTLS'],
			command: (line) =>
				line === 'STARTTLS' ? '220 go\r\n250 injected\r\n' : undefined,
		});
		expect(error.message).toBe('127.0.0.1 sent more after its 220 to STARTTLS');
	});
});

describe('the session, against what the server offers', () => {
	test('EHLO refused with a 5xx: HELO instead (RFC 5321 §4.1.4)', async () => {
		const { port, lines } = await fakeServer({
			command: (line) =>
				line.startsWith('EHLO') ? '502 5.5.1 no\r\n' : undefined,
		});
		await sendMail(MESSAGE, {
			host: '127.0.0.1',
			port,
			from: 'a@bar.com',
			to: 'b@foo.com',
			helo: 'me.example',
		});
		expect(lines.slice(0, 2)).toEqual(['EHLO me.example', 'HELO me.example']);
	});

	test('PIPELINING sends MAIL FROM and every RCPT TO at once (RFC 2920); without it, one by one', async () => {
		for (const pipelining of [true, false]) {
			let seenAtMail = 0;
			const { port, lines } = await fakeServer({
				ehlo: pipelining ? ['PIPELINING'] : [],
				command(line, socket) {
					if (!line.startsWith('MAIL')) return undefined;
					setTimeout(() => {
						seenAtMail = lines.length;
						socket.write('250 ok\r\n');
					}, 50);
					return '';
				},
			});
			await sendMail(MESSAGE, {
				host: '127.0.0.1',
				port,
				from: 'a@bar.com',
				to: ['b@foo.com', 'c@foo.com'],
			});
			// EHLO, MAIL, then both RCPTs before the reply to MAIL — or not.
			expect(seenAtMail).toBe(pipelining ? 4 : 2);
		}
	});

	test('an extension the message needs and the server lacks', async () => {
		const utf8 = await against({}, { to: 'zoë@foo.com' });
		expect(utf8.error).toMatchObject({
			code: 'EXTENSION_MISSING',
			temporary: false,
		});
		expect(utf8.error.message).toBe(
			'127.0.0.1 does not offer SMTPUTF8, which an address that is not ASCII needs (or smtputf8 asked for)',
		);
		const bytes = await against({ ehlo: [] }, {}, 'Subject: x\r\n\r\ncafé\r\n');
		expect(bytes.error.message).toBe(
			'127.0.0.1 does not offer 8BITMIME, which the message needs: it has 8-bit bytes',
		);
		expect(bytes.lines.some((line) => line.startsWith('MAIL'))).toBe(false);
		const stream = new Blob(['Subject: x\r\n\r\ncafé\r\n']).stream();
		const streamed = await against({ ehlo: [] }, {}, stream);
		expect(streamed.error.code).toBe('EXTENSION_MISSING');
		expect(streamed.lines.some((line) => line.startsWith('<message'))).toBe(
			false,
		);
	});

	test('a bare LF in a stream: refused, and no final dot', async () => {
		const stream = new Blob(['Subject: x\r\n\r\nsmuggled\n.\r\n']).stream();
		const { error, lines } = await against({}, {}, stream);
		expect(error.code).toBe('BARE_LINE_BREAK');
		expect(lines.some((line) => line.startsWith('<message'))).toBe(false);
	});

	test('a stream that ends in a bare CR: refused, and no final dot', async () => {
		const stream = new Blob(['Subject: x\r\n\r\nends in a CR\r']).stream();
		const { error, lines } = await against({}, {}, stream);
		expect(error.code).toBe('BARE_LINE_BREAK');
		expect(lines.some((line) => line.startsWith('<message'))).toBe(false);
	});
});

describe('an address cannot inject a command (RFC 5321 §4.1.1.3)', () => {
	/** Sends with `options` to a fake server offering SMTPUTF8; the error, the lines it got and whether anyone connected. */
	async function injected(options: Partial<SendMailEnvelope>) {
		let connected = 0;
		const { port, lines } = await fakeServer({
			ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8'],
			connected: () => {
				connected++;
				return undefined;
			},
		});
		const error = await sendMail(MESSAGE, {
			host: '127.0.0.1',
			port,
			from: 'a@bar.com',
			to: 'b@foo.com',
			...options,
		}).then(
			() => undefined,
			(e: unknown) => e,
		);
		await Bun.sleep(20);
		return { error: error as SmtpError, lines, connected };
	}

	test('a CR LF in a source route is refused before anything is written', async () => {
		const { error, lines, connected } = await injected({
			to: '@x\r\nRSET\r\nNOOP:a@c.com',
		});
		expect(error).toBeInstanceOf(SmtpError);
		expect(error).toMatchObject({ code: 'INVALID_OPTION', temporary: false });
		expect(error.message).toBe(
			'sendMail(): "@x\\r\\nRSET\\r\\nNOOP:a@c.com" is not an address (local@domain)',
		);
		expect(connected).toBe(0);
		expect(lines).toEqual([]);
	});

	test('a valid source route is refused too: a client does not send one', async () => {
		const { error, lines, connected } = await injected({
			to: '@a,@b:x@c.com',
		});
		expect(error.message).toBe(
			'sendMail(): "@a,@b:x@c.com" holds a source route (@host:), which RFC 5321 says a client should not send: pass "x@c.com" alone',
		);
		expect(connected).toBe(0);
		expect(lines).toEqual([]);
	});

	test('CR, LF, NUL or > anywhere in from or to: nothing is written', async () => {
		const shapes = [
			(c: string) => `${c}a@c.com`,
			(c: string) => `a${c}@c.com`,
			(c: string) => `"a${c}b"@c.com`,
			(c: string) => `a@c${c}.com`,
			(c: string) => `a@c.com${c}`,
			(c: string) => `@x${c}:a@c.com`,
			(c: string) => `@x,@y${c}:a@c.com`,
		];
		for (const shape of shapes) {
			for (const char of ['\r', '\n', '\r\n', '\x00', '>']) {
				for (const field of ['from', 'to'] as const) {
					const { error, lines, connected } = await injected({
						[field]: shape(char),
					});
					expect([shape(char), field, error?.code]).toEqual([
						shape(char),
						field,
						'INVALID_OPTION',
					]);
					expect(connected).toBe(0);
					expect(lines).toEqual([]);
				}
			}
		}
	});
});
