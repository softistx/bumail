import { describe, expect, test } from 'bun:test';
import type { SmtpError } from '../errors';
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

describe("the message's signal tells onData the server refused it", () => {
	test('onData that read it all but answers after hookTimeout: 451, and its signal aborts', async () => {
		const { promise: go, resolve: release } = Promise.withResolvers<void>();
		const { promise: seen, resolve: done } = Promise.withResolvers<{
			text: string;
			signal: AbortSignal;
		}>();
		const s = await fakeSession(
			mxOptions({
				hookTimeout: 1,
				onData: async (message) => {
					const text = new TextDecoder().decode(await readContent(message));
					await go;
					done({ text, signal: message.signal });
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		release();
		const { text, signal } = await seen;
		// The read ended cleanly: only the signal says the message was refused.
		expect(text).toEndWith('hi\r\n');
		expect(signal.aborted).toBe(true);
		expect((signal.reason as SmtpError).code).toBe('HOOK_TIMEOUT');
	});

	test('the signal aborts with MESSAGE_NOT_READ when onData answers early, and never on a 250', async () => {
		let early: AbortSignal | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: (message) => {
					early = message.signal;
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect((early?.reason as SmtpError | undefined)?.code).toBe(
			'MESSAGE_NOT_READ',
		);

		let kept: AbortSignal | undefined;
		const t = await fakeSession(
			mxOptions({
				onData: async (message) => {
					await readContent(message);
					kept = message.signal;
				},
			}),
			{ raw: true },
		);
		await t.send(transaction);
		expect(await t.send('hi\r\n.\r\n')).toStartWith('250 2.0.0');
		expect(kept?.aborted).toBe(false);
	});

	test('the signal aborts with the reason the stream errored with', async () => {
		let signal: AbortSignal | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					signal = message.signal;
					await outcome(message.content);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('a\nb\r\n.\r\n')).toStartWith('550 5.6.11');
		expect((signal?.reason as SmtpError | undefined)?.code).toBe(
			'BARE_LINE_BREAK',
		);
	});

	test('onData that throws after reading: 451, and its signal aborts with what it threw', async () => {
		const thrown = new Error('disk full');
		let signal: AbortSignal | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					signal = message.signal;
					await readContent(message);
					throw thrown;
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect(signal?.reason).toBe(thrown);
		expect(s.errors).toContain(thrown);
	});

	test('onData that answers what is not a refusal: 451, and its signal aborts with INVALID_HOOK_REPLY', async () => {
		let signal: AbortSignal | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					signal = message.signal;
					await readContent(message);
					return reply(250, '2.0.0', 'Mine');
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect((signal?.reason as SmtpError | undefined)?.code).toBe(
			'INVALID_HOOK_REPLY',
		);
	});

	test("onData's own refusal leaves the signal alone: it chose it", async () => {
		let signal: AbortSignal | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					signal = message.signal;
					await readContent(message);
					return reply(554, '5.7.1', 'Spam');
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toBe('554 5.7.1 Spam\r\n');
		expect(signal?.aborted).toBe(false);
	});

	test('the client leaving after the final dot, before the reply: the signal aborts with CONNECTION_LOST', async () => {
		const read = Promise.withResolvers<AbortSignal>();
		const answer = Promise.withResolvers<void>();
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					await readContent(message);
					read.resolve(message.signal);
					await answer.promise;
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		void s.send('hi\r\n.\r\n').catch(() => undefined);
		const signal = await read.promise;
		expect(signal.aborted).toBe(false);
		s.connection.close();
		answer.resolve();
		expect((signal.reason as SmtpError | undefined)?.code).toBe(
			'CONNECTION_LOST',
		);
		expect((signal.reason as SmtpError).message).toBe(
			'The client disconnected before the reply to the message; do not deliver it',
		);
	});

	test('the reply sent, a client leaving afterwards does not abort the signal', async () => {
		let signal: AbortSignal | undefined;
		const s = await fakeSession(
			mxOptions({
				onData: async (message) => {
					signal = message.signal;
					await readContent(message);
				},
			}),
			{ raw: true },
		);
		await s.send(transaction);
		expect(await s.send('hi\r\n.\r\n')).toStartWith('250 2.0.0');
		s.connection.close();
		expect(signal?.aborted).toBe(false);
	});
});
