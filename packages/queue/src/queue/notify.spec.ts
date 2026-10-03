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

const to = (...addresses: string[]) => ({
	from: 'mary@example.net',
	to: addresses,
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
