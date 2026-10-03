import { describe, expect, test } from 'bun:test';
import { SmtpError } from '@bumail/smtp/client';
import {
	accepted,
	HOUR,
	MESSAGE,
	MINUTE,
	reply,
	setup,
	T0,
} from './queue.fixtures';

/** The events about mary's own message, not about the DSN it caused. */
const own = <E extends { from: string }>(events: E[]) =>
	events.filter((e) => e.from !== '');

const to = (...addresses: string[]) => ({
	from: 'mary@example.net',
	to: addresses,
});

describe('RFC 5321 §4.2.1: a 5xx fails at once, a 4xx is deferred', () => {
	test('a RCPT refused with 550 fails at once; the others are delivered', async () => {
		const { queue, events, store } = setup((call) =>
			accepted(call.options, {
				'nobody@example.com': reply(550, '5.1.1', 'No such user'),
			}),
		);
		const item = await queue.enqueue(
			MESSAGE,
			to('joe@example.com', 'nobody@example.com'),
		);
		await queue.deliverDue();
		expect(own(events.delivered).map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		expect(own(events.failed)).toEqual([
			{
				id: item.id,
				from: 'mary@example.net',
				recipient: 'nobody@example.com',
				reply: {
					code: 550,
					status: '5.1.1',
					text: 'No such user',
					host: 'mx.example.com',
				},
				attempts: 1,
			},
		]);
		expect(await store.get(item.id)).toBeUndefined();
	});

	test('every RCPT refused: each by its own reply', async () => {
		const rejected = [
			{ recipient: 'a@example.com', reply: reply(550, '5.1.1', 'unknown') },
			{
				recipient: 'b@example.com',
				reply: reply(452, '4.2.2', 'mailbox full'),
			},
		];
		const { queue, events } = setup(
			() =>
				new SmtpError('RECIPIENTS_REFUSED', 'every recipient refused', {
					reply: reply(550, '5.1.1', 'unknown'),
					rejected,
				}),
		);
		await queue.enqueue(MESSAGE, to('a@example.com', 'b@example.com'));
		await queue.deliverDue();
		expect(own(events.failed).map((e) => e.recipient)).toEqual([
			'a@example.com',
		]);
		expect(events.deferred.map((e) => e.recipient)).toEqual(['b@example.com']);
		expect(events.deferred[0]?.reply?.status).toBe('4.2.2');
	});

	test('a 5xx to MAIL FROM fails the whole domain', async () => {
		const { queue, events } = setup(
			() =>
				new SmtpError('REFUSED', 'mx refused MAIL FROM', {
					reply: reply(550, '5.7.1', 'Sender rejected'),
				}),
		);
		await queue.enqueue(MESSAGE, to('a@example.com', 'b@example.com'));
		await queue.deliverDue();
		expect(own(events.failed).map((e) => e.reply?.status)).toEqual([
			'5.7.1',
			'5.7.1',
		]);
	});
});

describe('a connection error or a timeout counts as temporary', () => {
	for (const [code, status] of [
		['CONNECTION_FAILED', '4.4.1'],
		['TIMEOUT', '4.4.2'],
		['CONNECTION_LOST', '4.4.2'],
		['TLS_FAILED', '4.7.0'],
	] as const) {
		test(`${code} is deferred, as ${status}`, async () => {
			const { queue, events } = setup(
				() => new SmtpError(code, `${code} with mx.example.com`),
			);
			await queue.enqueue(MESSAGE, to('a@example.com'));
			await queue.deliverDue();
			expect(events.deferred[0]?.reply).toEqual({
				status,
				text: `${code} with mx.example.com`,
			});
		});
	}

	test('an error that is not an SmtpError is temporary too', async () => {
		const { queue, events } = setup(() => new TypeError('socket gone'));
		await queue.enqueue(MESSAGE, to('a@example.com'));
		await queue.deliverDue();
		expect(events.deferred[0]?.reply).toEqual({
			status: '4.0.0',
			text: 'socket gone',
		});
	});

	test('a null MX is permanent: X.1.10 (RFC 7505 §4.2)', async () => {
		const { queue, events } = setup(
			() =>
				new SmtpError('NULL_MX', 'example.com accepts no mail', {
					temporary: false,
				}),
		);
		await queue.enqueue(MESSAGE, to('a@example.com'));
		await queue.deliverDue();
		expect(events.failed[0]?.reply?.status).toBe('5.1.10');
	});
});

describe('what a server says is bounded and cleaned', () => {
	test('control characters, CR and LF become spaces; the text is cut at maxReplyText', async () => {
		const evil = `no\r\nSubject: injected\r\n\r\n${'x'.repeat(2000)}`;
		const { queue, events, sender } = setup(
			(call) =>
				accepted(call.options, {
					'a@example.com': reply(550, '5.1.1', evil),
				}),
			{ limits: { maxReplyText: 100 } },
		);
		await queue.enqueue(MESSAGE, to('a@example.com'));
		await queue.deliverDue();
		const text = events.failed[0]?.reply?.text ?? '';
		expect(text).toHaveLength(100);
		expect(text.startsWith('no Subject: injected xxx')).toBe(true);
		expect(text.endsWith('...')).toBe(true);
		const dsn = sender.calls.find((c) => c.options.from === '')?.text ?? '';
		expect(dsn).toContain('Diagnostic-Code: smtp; 550 no Subject: injected');
		expect(dsn).not.toContain('\r\nSubject: injected');
	});
});

describe('DSNs go back to the sender, never about a DSN', () => {
	test('a failure sends one DSN, from the null sender, to the original sender', async () => {
		const { queue, events, store } = setup((call) =>
			call.options.from === ''
				? accepted(call.options)
				: accepted(call.options, {
						'a@example.com': reply(550, '5.1.1', 'no'),
					}),
		);
		const item = await queue.enqueue(MESSAGE, to('a@example.com'));
		await queue.deliverDue();
		expect(events.dsn).toHaveLength(1);
		expect(events.dsn[0]).toMatchObject({
			kind: 'failed',
			of: item.id,
			to: 'mary@example.net',
			recipients: ['a@example.com'],
		});
		// The DSN was enqueued with the null sender and delivered in the same pass.
		expect(events.delivered).toMatchObject([
			{ id: events.dsn[0]?.id, from: '', recipient: 'mary@example.net' },
		]);
		expect(await store.count()).toBe(0);
	});

	test('a message from the null sender never causes a DSN, failed or delayed', async () => {
		const { queue, events, clock } = setup(
			(call) =>
				accepted(call.options, { 'a@example.com': reply(550, '5.1.1', 'no') }),
			{ dsn: { delayAfter: 0 } },
		);
		await queue.enqueue(MESSAGE, {
			from: '',
			to: ['a@example.com', 'b@example.com'],
		});
		await queue.deliverDue();
		clock.advance(HOUR);
		await queue.deliverDue();
		expect(events.failed).toHaveLength(1);
		expect(events.dsn).toEqual([]);
	});

	test('a "delayed" DSN once the message waited 4 hours, sent once', async () => {
		const { queue, events, clock, store } = setup((call) =>
			call.options.from === ''
				? accepted(call.options)
				: new SmtpError('TIMEOUT', 'timed out'),
		);
		await queue.enqueue(MESSAGE, to('a@example.com'));
		for (let i = 0; i < 6; i++) {
			const due = (await store.list())[0]?.nextAttemptAt ?? T0;
			clock.advance(Math.max(0, due - clock.now()));
			await queue.deliverDue();
		}
		expect(clock.now() - T0).toBeGreaterThan(4 * HOUR);
		expect(events.dsn.map((d) => d.kind)).toEqual(['delayed']);
		const first = events.deferred.findIndex(
			(e) => e.nextAttemptAt - T0 > 4 * HOUR - 30 * MINUTE,
		);
		expect(first).toBeGreaterThan(0);
		expect((await store.list())[0]?.delayNotified).toBe(true);
	});
});
