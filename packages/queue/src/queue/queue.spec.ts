import { describe, expect, test } from 'bun:test';
import { accepted, MESSAGE, MINUTE, reply, setup, T0 } from './queue.fixtures';

const envelope = {
	from: 'mary@example.net',
	to: ['joe@example.com', 'ann@example.com', 'bob@example.org'],
};

describe('enqueue', () => {
	test('keeps the message and each recipient pending, due at once', async () => {
		const { queue, store } = setup();
		const item = await queue.enqueue(MESSAGE, envelope);
		expect(item.recipients.map((r) => [r.address, r.status])).toEqual([
			['joe@example.com', 'pending'],
			['ann@example.com', 'pending'],
			['bob@example.org', 'pending'],
		]);
		expect(item).toMatchObject({ createdAt: T0, nextAttemptAt: T0 });
		expect(new TextDecoder().decode(await store.readMessage(item.id))).toBe(
			MESSAGE,
		);
	});

	test('takes bytes, a string or a stream, and one recipient as a string', async () => {
		const { queue, store } = setup();
		const bytes = new TextEncoder().encode(MESSAGE);
		const stream = new Blob([bytes]).stream();
		for (const message of [bytes, MESSAGE, stream]) {
			const item = await queue.enqueue(message, {
				from: 'mary@example.net',
				to: 'joe@example.com',
			});
			expect(await store.readMessage(item.id)).toEqual(bytes);
		}
	});

	test('lists each recipient once, the domain compared in lowercase', async () => {
		const { queue } = setup();
		const item = await queue.enqueue(MESSAGE, {
			from: '',
			to: ['joe@example.com', 'joe@EXAMPLE.com', 'Joe@example.com'],
		});
		expect(item.recipients.map((r) => r.address)).toEqual([
			'joe@example.com',
			'Joe@example.com',
		]);
		expect(item.from).toBe('');
	});

	test('refuses an address that could break a command line or a header field', async () => {
		const { queue } = setup();
		for (const bad of [
			'joe@example.com\r\nRCPT TO:<x@y>',
			'joe@exa mple.com',
			'<joe@example.com>',
			'joe',
			'joe@',
			`${'a'.repeat(65)}@example.com`,
			'joe@exa\u0000mple.com',
		]) {
			await expect(
				queue.enqueue(MESSAGE, { from: 'mary@example.net', to: [bad] }),
			).rejects.toMatchObject({ code: 'INVALID' });
		}
		await expect(
			queue.enqueue(MESSAGE, { from: 'mary@example.net\n', to: ['a@b.c'] }),
		).rejects.toThrow('from must be an address');
		await expect(
			queue.enqueue(MESSAGE, { from: 'mary@example.net', to: [] }),
		).rejects.toThrow('to must hold one recipient or more');
	});

	test('bounds the size, the recipients and the queue', async () => {
		const { queue } = setup(undefined, {
			limits: { maxMessageSize: 64, maxRecipients: 2, maxItems: 1 },
		});
		await expect(
			queue.enqueue('x'.repeat(65), { from: '', to: 'a@b.c' }),
		).rejects.toThrow('The message is larger than the limit of 64 bytes');
		const endless = new ReadableStream<Uint8Array>({
			pull: (c) => c.enqueue(new Uint8Array(16)),
		});
		await expect(
			queue.enqueue(endless, { from: '', to: 'a@b.c' }),
		).rejects.toMatchObject({ code: 'MESSAGE_TOO_BIG' });
		await expect(
			queue.enqueue('x', { from: '', to: ['a@b.c', 'b@b.c', 'c@b.c'] }),
		).rejects.toThrow('The message has 3 recipients; the limit is 2');
		await queue.enqueue('x', { from: '', to: 'a@b.c' });
		await expect(queue.enqueue('x', { from: '', to: 'a@b.c' })).rejects.toThrow(
			'The queue holds 1 items, its limit',
		);
	});
});

describe('delivery', () => {
	test('one session per domain, every recipient delivered, the item gone', async () => {
		const { queue, sender, store, events } = setup();
		const item = await queue.enqueue(MESSAGE, envelope);
		expect(await queue.deliverDue()).toBe(1);
		expect(sender.calls.map((c) => c.to)).toEqual([
			['joe@example.com', 'ann@example.com'],
			['bob@example.org'],
		]);
		expect(sender.calls[0]?.options).toMatchObject({
			from: 'mary@example.net',
			helo: 'mail.example.net',
			domain: 'example.com',
		});
		expect(sender.calls[0]?.text).toBe(MESSAGE);
		expect(events.delivered.map((e) => e.recipient)).toEqual(envelope.to);
		expect(events.delivered[0]).toMatchObject({
			id: item.id,
			attempts: 1,
			reply: { code: 250, status: '2.0.0', text: 'Queued as 42' },
		});
		expect(await store.count()).toBe(0);
		expect(await queue.deliverDue()).toBe(0);
	});
});

describe('admin', () => {
	test('list and get show items; retryNow makes one due; cancel drops it', async () => {
		const { queue, clock, sender } = setup((call) =>
			accepted(call.options, {
				'joe@example.com': reply(451, '4.3.0', 'busy'),
			}),
		);
		const item = await queue.enqueue(MESSAGE, {
			from: 'mary@example.net',
			to: 'joe@example.com',
		});
		await queue.deliverDue();
		const [listed] = await queue.list();
		expect(listed?.id).toBe(item.id);
		expect(listed?.nextAttemptAt).toBe(T0 + 30 * MINUTE);
		clock.advance(MINUTE);
		expect(await queue.retryNow(item.id)).toBe(true);
		expect((await queue.get(item.id))?.nextAttemptAt).toBe(T0 + MINUTE);
		await queue.deliverDue();
		expect(sender.calls.length).toBe(2);
		expect((await queue.cancel(item.id))?.id).toBe(item.id);
		expect(await queue.get(item.id)).toBeUndefined();
		expect(await queue.retryNow(item.id)).toBe(false);
		expect(await queue.cancel(item.id)).toBeUndefined();
	});
});
