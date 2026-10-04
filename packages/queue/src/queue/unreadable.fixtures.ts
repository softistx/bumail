import { describe, expect, test } from 'bun:test';
import type { CreateStore } from '../contract/fixtures/setup.fixtures';
import type { QueueStore } from '../contract/queue-store';
import { createQueue } from './queue';
import {
	accepted,
	fakeClock,
	fakeSender,
	MESSAGE,
	MINUTE,
	NO_DNS,
	recordEvents,
	reply,
	type Script,
} from './queue.fixtures';

/**
 * Takes an item's message out of `store`, as damage would — a Redis key
 * evicted or deleted, a row removed by hand — and leaves the item.
 */
export type LoseMessage = (store: QueueStore, id: string) => Promise<void>;

/**
 * `store` seen through a handle whose `readMessage` gives nothing for the
 * ids `lose` names: for a store no spec can damage from outside, as the
 * memory store.
 */
export function hidingMessages(store: QueueStore): {
	store: QueueStore;
	lose: LoseMessage;
} {
	const lost = new Set<string>();
	const seen = new Proxy(store, {
		get(target, key) {
			if (key === 'readMessage') {
				return async (id: string) =>
					lost.has(id) ? undefined : target.readMessage(id);
			}
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return {
		store: seen,
		lose: async (_store, id) => {
			lost.add(id);
		},
	};
}

const UNREADABLE =
	'Message unreadable: the queue store holds the item but not its message';

/**
 * An item whose message the store no longer gives: its pending recipients
 * fail at once, the `error` event says why, the DSN goes without the
 * original, and the item leaves the queue rather than be claimed again at
 * every lease. Run by every store's spec; `lose` damages that store as it
 * can be damaged, or `hidingMessages` stands in for it.
 */
export function describeUnreadableMessage(
	name: string,
	create: CreateStore,
	lose?: LoseMessage,
): void {
	const open = async () => {
		const made = await create();
		return lose ? { store: made, lose } : hidingMessages(made);
	};
	const instance = (store: QueueStore, script?: Script) => {
		const clock = fakeClock();
		const sender = fakeSender(script);
		const queue = createQueue({
			store,
			hostname: 'mail.example.net',
			resolver: NO_DNS,
			clock,
			send: sender.send,
			random: () => 0,
			owner: 'w',
			limits: { maxItems: 1 },
		});
		return { queue, clock, sender, events: recordEvents(queue) };
	};

	describe(`${name}: a message the store lost`, () => {
		test('fails every pending recipient at once, tells the error event, and sends a DSN without the original', async () => {
			const { store, lose } = await open();
			const { queue, clock, sender, events } = instance(store);
			const item = await queue.enqueue(MESSAGE, {
				from: 'mary@example.net',
				to: ['joe@example.com', 'ann@example.org'],
			});
			await lose(store, item.id);
			// The item, then its DSN, due at once: two in one pass.
			expect(await queue.deliverDue()).toBe(2);
			expect(events.error).toEqual([
				{
					id: item.id,
					error: expect.objectContaining({
						name: 'QueueError',
						code: 'MESSAGE_UNREADABLE',
						message: `The message of ${item.id} is unreadable: the store holds the item but not its message, so every pending recipient failed`,
					}),
				},
			]);
			expect(events.failed.map((e) => [e.recipient, e.reply])).toEqual([
				['joe@example.com', { status: '5.3.0', text: UNREADABLE }],
				['ann@example.org', { status: '5.3.0', text: UNREADABLE }],
			]);
			expect(events.failed.map((e) => e.attempts)).toEqual([1, 1]);
			expect(await store.get(item.id)).toBeUndefined();
			// The DSN, past maxItems as every DSN, the only message sent: to mary, from <>.
			expect(events.dsn).toEqual([
				expect.objectContaining({
					kind: 'failed',
					of: item.id,
					to: 'mary@example.net',
					recipients: ['joe@example.com', 'ann@example.org'],
				}),
			]);
			expect(sender.calls.map((c) => [c.options.from, c.to])).toEqual([
				['', ['mary@example.net']],
			]);
			const dsn = sender.calls[0]?.text as string;
			expect(dsn).toContain('Your message could not be read from the queue');
			expect(dsn).toContain('Status: 5.3.0');
			expect(dsn).not.toContain('text/rfc822-headers');
			expect(dsn).not.toContain('Subject: Hi');
			expect(dsn).toEndWith('--\r\n');
			// Nothing comes back at the next lease.
			expect(await store.count()).toBe(0);
			clock.advance(10 * MINUTE);
			expect(await queue.deliverDue()).toBe(0);
		});

		test('fails only the recipients still pending, and sends no DSN for an item from <>', async () => {
			const { store, lose } = await open();
			const later = reply(451, '4.3.0', 'Try later');
			const { queue, clock, events } = instance(store, (call) =>
				accepted(call.options, { 'ann@example.org': later }),
			);
			const item = await queue.enqueue(MESSAGE, {
				from: '',
				to: ['joe@example.com', 'ann@example.org'],
			});
			expect(await queue.deliverDue()).toBe(1);
			expect(events.delivered.map((e) => e.recipient)).toEqual([
				'joe@example.com',
			]);
			await lose(store, item.id);
			clock.advance(30 * MINUTE);
			expect(await queue.deliverDue()).toBe(1);
			expect(events.failed.map((e) => [e.recipient, e.reply?.text])).toEqual([
				['ann@example.org', UNREADABLE],
			]);
			expect(events.failed[0]?.attempts).toBe(2);
			expect(events.error.map((e) => e.id)).toEqual([item.id]);
			expect(events.dsn).toEqual([]);
			expect(await store.count()).toBe(0);
		});
	});
}
