import { describe, expect, test } from 'bun:test';
import type { SendMailOptions } from '@bumail/smtp/client';
import { isMailbox, SmtpError } from '@bumail/smtp/client';
import { accepted, MESSAGE, setup } from './queue.fixtures';

/** The events about mary's own message, not about the DSN it caused. */
const own = <E extends { from: string }>(events: E[]) =>
	events.filter((e) => e.from !== '');

const to = (...addresses: string[]) => ({
	from: 'mary@example.net',
	to: addresses,
});

describe('an address sendMail would refuse never fails its domain', () => {
	/** A sender that checks its recipients as sendMail does. */
	const strict = (call: { options: SendMailOptions; to: string[] }) =>
		call.to.every(isMailbox)
			? accepted(call.options)
			: new SmtpError('INVALID_OPTION', 'sendMail(): not an address', {
					temporary: false,
				});

	test.each([
		'a(b)@c.com',
		'a,b@c.com',
		'"x@c.com',
		'a@b@c.com',
		'a@c.com,',
		'a@-c',
		'a..b@c.com',
		'.a@c.com',
	])('enqueue refuses %p, and keeps nothing', async (bad) => {
		const { queue, store } = setup(strict);
		await expect(
			queue.enqueue(MESSAGE, to('joe@c.com', bad)),
		).rejects.toMatchObject({
			code: 'INVALID',
			message: `Each recipient must be an address, local@domain, not ${JSON.stringify(bad)}`,
		});
		expect(await store.count()).toBe(0);
	});

	test('a bad address a store kept fails alone: its good sibling is delivered', async () => {
		const { queue, events, store, sender, clock } = setup(strict);
		const item = await store.add({
			from: 'mary@example.net',
			to: ['joe@c.com', 'a,b@c.com'],
			message: new TextEncoder().encode(MESSAGE),
			createdAt: clock.now(),
		});
		await queue.deliverDue();
		// The first session, for c.com; the second sends mary the DSN.
		expect(sender.calls.map((c) => c.to)).toEqual([
			['joe@c.com'],
			['mary@example.net'],
		]);
		expect(own(events.delivered).map((e) => e.recipient)).toEqual([
			'joe@c.com',
		]);
		expect(own(events.failed)).toMatchObject([
			{ id: item.id, recipient: 'a,b@c.com', reply: { status: '5.1.3' } },
		]);
		expect(events.error).toEqual([]);
	});

	test('a bad sender a store kept fails every recipient at once, as 5.1.7', async () => {
		const { queue, events, store, sender, clock } = setup(strict);
		const item = await store.add({
			from: 'a,b@example.net',
			to: ['joe@c.com', 'ann@d.com'],
			message: new TextEncoder().encode(MESSAGE),
			createdAt: clock.now(),
		});
		await queue.deliverDue();
		// No session for the item; its DSN, to a bad address, fails as 5.1.3.
		expect(sender.calls).toEqual([]);
		const failed = events.failed.filter((e) => e.id === item.id);
		expect(failed.map((e) => [e.recipient, e.reply?.status])).toEqual([
			['joe@c.com', '5.1.7'],
			['ann@d.com', '5.1.7'],
		]);
		expect(events.deferred).toEqual([]);
		expect(events.dsn).toMatchObject([
			{ kind: 'failed', of: item.id, to: 'a,b@example.net' },
		]);
		expect(events.failed.filter((e) => e.id !== item.id)).toMatchObject([
			{ from: '', recipient: 'a,b@example.net', reply: { status: '5.1.3' } },
		]);
		expect(await store.count()).toBe(0);
	});
});
