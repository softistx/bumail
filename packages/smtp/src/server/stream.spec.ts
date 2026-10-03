import { describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import { reply } from '../protocol/reply';
import { fakeSession, mxOptions, readContent } from './session.fixtures';

const transaction =
	'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n';

/** What onData's read of the stream ended with. */
async function outcome(content: ReadableStream<Uint8Array>) {
	try {
		const text = new TextDecoder().decode(await readContent({ content }));
		return { text };
	} catch (error) {
		return { error: error as SmtpError };
	}
}

describe('the message reaches onData as a stream', () => {
	test('onData sees the first bytes before the client has sent the end', async () => {
		let first = '';
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					const reader = message.content.getReader();
					first = new TextDecoder().decode((await reader.read()).value);
					while (!(await reader.read()).done);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('Subject: hi\r\n\r\npart one\r\n')).toBe('');
		expect(first).toStartWith('Received: from bar.com');
		expect(await s.send('part two\r\n.\r\n')).toStartWith(
			'250 2.0.0 OK queued as',
		);
	});

	test('smuggling errors the stream with BARE_LINE_BREAK, and the reply is 550 5.6.11', async () => {
		let read: Awaited<ReturnType<typeof outcome>> | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					read = await outcome(message.content);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('x\n.\nMAIL FROM:<admin@foo.com>\r\n.\r\n')).toBe(
			'550 5.6.11 Bare CR or LF is not allowed in a message\r\n',
		);
		expect(read?.error).toBeInstanceOf(SmtpError);
		expect(read?.error?.code).toBe('BARE_LINE_BREAK');
	});

	test('a message over maxMessageSize errors with MESSAGE_TOO_BIG, and the reply is 552', async () => {
		let read: Awaited<ReturnType<typeof outcome>> | undefined;
		const s = await fakeSession(
			mxOptions({
				maxMessageSize: 10,
				onData: async (message) => {
					read = await outcome(message.content);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send(`${'x'.repeat(50)}\r\n.\r\n`)).toBe(
			'552 5.3.4 Message too big for system\r\n',
		);
		expect(read?.error?.code).toBe('MESSAGE_TOO_BIG');
	});

	test('a refusal from onData is the reply, once the message ended', async () => {
		const s = await fakeSession(
			mxOptions({ onData: () => reply(554, '5.7.1', 'Spam') }),
		);
		await s.send(transaction);
		expect(await s.send('x\r\n.\r\n')).toBe('554 5.7.1 Spam\r\n');
	});

	test('the client hanging up mid-message errors the stream with CONNECTION_LOST', async () => {
		let read: Awaited<ReturnType<typeof outcome>> | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					read = await outcome(message.content);
				},
			}),
			{ raw: true },
		);
		await s.send(`${transaction}half a message\r\n`);
		s.connection.close();
		await Bun.sleep(1);
		expect(read?.error?.code).toBe('CONNECTION_LOST');
	});

	test('onData that stops reading: the server stops reading the client, then answers 451 after hookTimeout', async () => {
		const s = await fakeSession(
			mxOptions({
				hookTimeout: 1,
				onData: () => new Promise(() => {}),
			}),
			{ raw: true },
		);
		await s.send(transaction);
		const line = new TextEncoder().encode(`${'x'.repeat(998)}\r\n`);
		// Chunk after chunk, as a socket delivers them, none of them read.
		for (let i = 0; i < 200; i++) s.connection.receive(line);
		await Bun.sleep(100);
		expect(s.paused).toBe(true);
		expect(await s.send('.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect(s.paused).toBe(false);
		expect((s.errors[0] as SmtpError).code).toBe('HOOK_TIMEOUT');
	});

	test('onData that answers without reading to the end: 451 4.3.0 and MESSAGE_NOT_READ, never 250', async () => {
		const s = await fakeSession(mxOptions({ onData: () => undefined }), {
			raw: true,
		});
		await s.send(transaction);
		const big = `${'x'.repeat(998)}\r\n`.repeat(200);
		expect(await s.send(`${big}.\r\n`)).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect((s.errors[0] as SmtpError).code).toBe('MESSAGE_NOT_READ');
	});

	test('a short message onData never read: 451 4.3.0, not 250', async () => {
		const s = await fakeSession(mxOptions({ onData: () => undefined }), {
			raw: true,
		});
		await s.send(transaction);
		expect(await s.send('Subject: hi\r\n\r\nhi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect((s.errors[0] as SmtpError).code).toBe('MESSAGE_NOT_READ');
	});

	test('onData that cancels the stream: 451 4.3.0, and the session goes on', async () => {
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					await message.content.cancel();
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect((s.errors[0] as SmtpError).code).toBe('MESSAGE_NOT_READ');
		expect(await s.send('NOOP\r\n')).toBe('250 2.0.0 OK\r\n');
	});

	test('onData that reads the stream to its end gets the 250', async () => {
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					await readContent(message);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toStartWith('250 2.0.0 OK queued as');
		expect(s.errors).toEqual([]);
	});

	test('onData that answers after hookTimeout: 451, and a late read errors with HOOK_TIMEOUT', async () => {
		const { promise: go, resolve: release } = Promise.withResolvers<void>();
		const { promise: late, resolve: done } =
			Promise.withResolvers<Awaited<ReturnType<typeof outcome>>>();
		const s = await fakeSession(
			mxOptions({
				hookTimeout: 1,
				onData: async (message) => {
					// Starts reading only once the client was told 451.
					await go;
					done(await outcome(message.content));
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		release();
		expect((await late).error?.code).toBe('HOOK_TIMEOUT');
	});

	test('onData that leaves a read running and answers: 451, even if the read ends first', async () => {
		const s = await fakeSession(
			mxOptions({
				onData: (message) => {
					// It errors with MESSAGE_NOT_READ: see the next spec.
					new Response(message.content).text().catch(() => undefined);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hello\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect((s.errors[0] as SmtpError).code).toBe('MESSAGE_NOT_READ');
	});

	test('a reader left running after onData answered errors with MESSAGE_NOT_READ, never ends cleanly', async () => {
		let background: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: (message) => {
					background = outcome(message.content);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hello\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		const read = await background;
		expect(read?.text).toBeUndefined();
		expect(read?.error?.code).toBe('MESSAGE_NOT_READ');
	});

	test('a read started after onData answered errors with MESSAGE_NOT_READ too', async () => {
		let background: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: (message) => {
					background = new Promise((resolve) => {
						setTimeout(() => resolve(outcome(message.content)), 0);
					});
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hello\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		const read = await background;
		expect(read?.text).toBeUndefined();
		expect(read?.error?.code).toBe('MESSAGE_NOT_READ');
	});

	test('a refusal from onData stays the reply, and a read left running errors', async () => {
		let background: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: (message) => {
					background = outcome(message.content);
					return reply(550, '5.7.1', 'No');
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hello\r\n.\r\n')).toBe('550 5.7.1 No\r\n');
		const read = await background;
		expect(read?.text).toBeUndefined();
		expect(read?.error?.code).toBe('MESSAGE_NOT_READ');
	});
});
