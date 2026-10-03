import { afterEach, describe, expect, test } from 'bun:test';
import { reply } from '../protocol/reply';
import { failure, startServer, stopServers } from './client.fixtures';
import { sendMail } from './send';

afterEach(stopServers);

const MESSAGE =
	'From: a@bar.com\r\nTo: b@foo.com\r\nSubject: hi\r\n\r\nhello\r\n';
const to = (port: number) => ({ host: '127.0.0.1', port });

describe('sendMail to this package’s own server', () => {
	test('plain: delivered in clear when STARTTLS is not offered', async () => {
		const { port, received } = await startServer({}, true);
		const result = await sendMail(MESSAGE, {
			...to(port),
			from: 'a@bar.com',
			to: 'b@foo.com',
		});
		expect(result.reply.code).toBe(250);
		expect(result.reply.status).toBe('2.0.0');
		expect(result.accepted).toEqual([
			{
				recipient: 'b@foo.com',
				reply: { code: 250, status: '2.1.5', text: 'OK' },
			},
		]);
		expect(result.rejected).toEqual([]);
		expect(result).toMatchObject({
			host: '127.0.0.1',
			port,
			tls: false,
			authenticated: false,
		});
		expect(received[0]?.text).toEndWith(MESSAGE);
		expect(received[0]?.envelope).toEqual({
			from: 'a@bar.com',
			to: ['b@foo.com'],
			smtputf8: false,
			body: '8BITMIME',
		});
	});

	test('rejected recipients are collected; every one refused is RECIPIENTS_REFUSED', async () => {
		const { port, received } = await startServer({
			onRcptTo: (path) =>
				path.local === 'busy' ? reply(451, '4.2.1', 'Try later') : undefined,
		});
		const result = await sendMail(MESSAGE, {
			...to(port),
			from: 'a@bar.com',
			to: ['b@foo.com', 'busy@foo.com', 'c@elsewhere.example'],
		});
		expect(result.accepted.map((r) => r.recipient)).toEqual(['b@foo.com']);
		expect(result.rejected).toEqual([
			{
				recipient: 'busy@foo.com',
				reply: { code: 451, status: '4.2.1', text: 'Try later' },
			},
			{
				recipient: 'c@elsewhere.example',
				reply: { code: 554, status: '5.7.1', text: 'Relay access denied' },
			},
		]);
		expect(received[0]?.envelope.to).toEqual(['b@foo.com']);
		const error = await failure(
			sendMail(MESSAGE, {
				...to(port),
				from: 'a@bar.com',
				to: ['busy@foo.com', 'x@other.example'],
			}),
		);
		expect(error).toMatchObject({
			code: 'RECIPIENTS_REFUSED',
			temporary: true,
		});
		expect(error.rejected).toHaveLength(2);
		expect(error.message).toBe(
			'127.0.0.1 refused every recipient, busy@foo.com with 451 4.2.1 Try later',
		);
	});

	test('a 4xx from the server is temporary, a 5xx permanent, the enhanced status kept', async () => {
		let code = 451;
		const { port } = await startServer({
			onMailFrom: () => reply(code, `${String(code)[0]}.7.1`, 'Not now'),
		});
		const options = { ...to(port), from: 'a@bar.com', to: 'b@foo.com' };
		const soft = await failure(sendMail(MESSAGE, options));
		expect(soft).toMatchObject({ code: 'REFUSED', temporary: true });
		expect(soft.reply).toEqual({ code: 451, status: '4.7.1', text: 'Not now' });
		expect(soft.message).toBe(
			'127.0.0.1 refused the sender: 451 4.7.1 Not now',
		);
		code = 550;
		const hard = await failure(sendMail(MESSAGE, options));
		expect(hard).toMatchObject({ code: 'REFUSED', temporary: false });
	});

	test('SIZE: a message larger than the server takes is refused before MAIL FROM', async () => {
		const { port, received } = await startServer({ maxMessageSize: 1000 });
		const options = { ...to(port), from: 'a@bar.com', to: 'b@foo.com' };
		const big = `Subject: big\r\n\r\n${'x'.repeat(2000)}\r\n`;
		const error = await failure(sendMail(big, options));
		expect(error).toMatchObject({ code: 'MESSAGE_TOO_BIG', temporary: false });
		expect(error.message).toBe(
			'The message (2018 bytes) is larger than the 1000 bytes 127.0.0.1 takes (SIZE)',
		);
		await sendMail(MESSAGE, options);
		expect(received).toHaveLength(1);
	});

	test('8BITMIME and SMTPUTF8: an address that is not ASCII, a body that is not 7-bit', async () => {
		const { port, received } = await startServer({
			localDomains: ['foo.com', 'exämple.com'],
		});
		const text = 'Subject: =?utf-8?q?caf=C3=A9?=\r\n\r\ncafé\r\n';
		await sendMail(text, {
			...to(port),
			from: 'josé@bar.com',
			to: 'zoë@exämple.com',
		});
		expect(received[0]?.envelope).toMatchObject({
			from: 'josé@bar.com',
			to: ['zoë@exämple.com'],
			smtputf8: true,
			body: '8BITMIME',
		});
		expect(received[0]?.text).toEndWith(text);
	});

	test('a large streamed message arrives whole', async () => {
		const { port, received } = await startServer({
			maxMessageSize: 64 * 1024 * 1024,
		});
		const line = `${'0123456789'.repeat(7)}\r\n`;
		const chunk = new TextEncoder().encode(line.repeat(1000));
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent === 0)
					controller.enqueue(new TextEncoder().encode('Subject: big\r\n\r\n'));
				if (sent++ >= 100) return controller.close();
				controller.enqueue(chunk);
			},
		});
		const result = await sendMail(stream, {
			...to(port),
			from: 'a@bar.com',
			to: 'b@foo.com',
		});
		expect(result.reply.code).toBe(250);
		expect(received[0]?.text).toEndWith(
			`Subject: big\r\n\r\n${line.repeat(100_000)}`,
		);
	});

	test('dot-stuffing: lines that start with a dot arrive as they were (RFC 5321 §4.5.2)', async () => {
		const { port, received } = await startServer();
		const text = 'Subject: dots\r\n\r\n.\r\n..\r\n.hidden\r\nend\r\n.';
		await sendMail(text, { ...to(port), from: 'a@bar.com', to: 'b@foo.com' });
		// A last line without CRLF gets one: the terminator needs it.
		expect(received[0]?.text).toEndWith(`${text}\r\n`);
	});

	test('a bare LF is refused before connecting, or turned into CRLF with normalizeLineEnds', async () => {
		const { port, received } = await startServer();
		const options = { ...to(port), from: 'a@bar.com', to: 'b@foo.com' };
		const error = await failure(
			sendMail('Subject: x\n\nsmuggled\n.\n', options),
		);
		expect(error).toMatchObject({ code: 'BARE_LINE_BREAK', temporary: false });
		expect(received).toHaveLength(0);
		await sendMail('Subject: x\n\nfixed\r\n', {
			...options,
			normalizeLineEnds: true,
		});
		expect(received[0]?.text).toEndWith('Subject: x\r\n\r\nfixed\r\n');
	});
});
