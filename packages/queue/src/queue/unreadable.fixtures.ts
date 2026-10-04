import { describe, expect, test } from 'bun:test';
import type { CreateStore } from '../contract/fixtures/setup.fixtures';
import type { QueueStore } from '../contract/queue-store';
import {
	completing,
	hidingMessages,
	instance,
	type LoseMessage,
} from './doubles.fixtures';
import { accepted, MESSAGE, MINUTE, reply } from './queue.fixtures';

const UNREADABLE =
	'Message unreadable: the queue store holds the item but not its message';

const FROM_MARY = {
	from: 'mary@example.net',
	to: ['joe@example.com', 'ann@example.org'],
};

/** A store, and how to lose a message of it. */
interface Damageable {
	readonly store: QueueStore;
	readonly lose: (id: string) => Promise<void>;
}

type Open = () => Promise<Damageable>;

const unreadableError = (id: string) => ({
	id,
	error: expect.objectContaining({
		name: 'QueueError',
		code: 'MESSAGE_UNREADABLE',
		message: `The message of ${id} is unreadable: the store holds the item but not its message, so every pending recipient failed`,
	}),
});

/**
 * An item whose message the store no longer gives: its pending recipients
 * fail at once, the `error` event says why once that is recorded, the DSN
 * goes without the original, and the item leaves the queue rather than be
 * claimed again at every lease. Run by every store's spec; `lose` damages
 * that store as it can be damaged, or `hidingMessages` stands in for it.
 */
export function describeUnreadableMessage(
	name: string,
	create: CreateStore,
	lose?: LoseMessage,
): void {
	const open: Open = async () => {
		const made = await create();
		if (lose) return { store: made, lose: (id) => lose(made, id) };
		const hidden = hidingMessages(made);
		return { store: hidden.store, lose: (id) => hidden.lose(made, id) };
	};
	describe(`${name}: a message the store lost`, () => {
		failsEveryPending(open);
		failsOnlyPending(open);
		toldOnceRecorded(open);
		leaseLostAtRecord(open);
		completeThrows(open);
		cancelledAtRecord(open);
	});
}

function failsEveryPending(open: Open): void {
	test('fails every pending recipient at once, tells the error event, and sends a DSN without the original', async () => {
		const { store, lose } = await open();
		const { queue, clock, sender, events } = instance(store);
		const item = await queue.enqueue(MESSAGE, FROM_MARY);
		await lose(item.id);
		// The item, then its DSN, due at once: two in one pass.
		expect(await queue.deliverDue()).toBe(2);
		expect(events.error).toEqual([unreadableError(item.id)]);
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
}

function failsOnlyPending(open: Open): void {
	test('fails only the recipients still pending, and sends no DSN for an item from <>', async () => {
		const { store, lose } = await open();
		const later = reply(451, '4.3.0', 'Try later');
		const { queue, clock, events } = instance(store, (call) =>
			accepted(call.options, { 'ann@example.org': later }),
		);
		const item = await queue.enqueue(MESSAGE, { ...FROM_MARY, from: '' });
		expect(await queue.deliverDue()).toBe(1);
		expect(events.delivered.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		await lose(item.id);
		clock.advance(30 * MINUTE);
		expect(await queue.deliverDue()).toBe(1);
		expect(events.failed.map((e) => [e.recipient, e.reply?.text])).toEqual([
			['ann@example.org', UNREADABLE],
		]);
		expect(events.failed[0]?.attempts).toBe(2);
		expect(events.error).toEqual([unreadableError(item.id)]);
		expect(events.dsn).toEqual([]);
		expect(await store.count()).toBe(0);
	});
}

function toldOnceRecorded(open: Open): void {
	test('the error comes once the outcome is recorded, before the failed events and the DSN', async () => {
		const { store: base, lose } = await open();
		const order: string[] = [];
		const store = completing(base, async (target, id, owner, result) => {
			const after = await target.complete(id, owner, result);
			order.push('recorded');
			return after;
		});
		const { queue } = instance(store);
		for (const event of ['error', 'failed', 'dsn', 'delivered'] as const) {
			queue.on(event, () => order.push(event));
		}
		const item = await queue.enqueue(MESSAGE, FROM_MARY);
		await lose(item.id);
		expect(await queue.deliverDue()).toBe(2);
		// The item's record and events, then the DSN's own delivery.
		expect(order).toEqual([
			'recorded',
			'error',
			'failed',
			'failed',
			'dsn',
			'recorded',
			'delivered',
		]);
	});
}

function leaseLostAtRecord(open: Open): void {
	test('a lease lost before the failures are recorded says LEASE_LOST only; the next attempt tells MESSAGE_UNREADABLE once', async () => {
		const { store: base, lose } = await open();
		let taken = false;
		const store = completing(base, async (target, id, owner, result) => {
			if (!taken) {
				// The lease let go of meanwhile: complete finds it no longer held.
				taken = true;
				await target.reschedule(id, result.now + MINUTE, owner);
			}
			return target.complete(id, owner, result);
		});
		const { queue, clock, events } = instance(store);
		const item = await queue.enqueue(MESSAGE, FROM_MARY);
		await lose(item.id);
		expect(await queue.deliverDue()).toBe(1);
		expect(events.error.map((e) => (e.error as { code: string }).code)).toEqual(
			['LEASE_LOST'],
		);
		expect(events.failed).toEqual([]);
		expect(events.dsn).toEqual([]);
		expect((await store.get(item.id))?.attempts).toBe(0);
		clock.advance(MINUTE);
		expect(await queue.deliverDue()).toBe(2);
		expect(events.error.map((e) => (e.error as { code: string }).code)).toEqual(
			['LEASE_LOST', 'MESSAGE_UNREADABLE'],
		);
		expect(events.failed).toHaveLength(2);
		expect(events.dsn).toHaveLength(1);
	});
}

function completeThrows(open: Open): void {
	test('a complete that throws is told on error as it is, with no MESSAGE_UNREADABLE and no failure', async () => {
		const { store: base, lose } = await open();
		const down = new Error('store down');
		const store = completing(base, async () => {
			throw down;
		});
		const { queue, events } = instance(store);
		const item = await queue.enqueue(MESSAGE, FROM_MARY);
		await lose(item.id);
		expect(await queue.deliverDue()).toBe(1);
		expect(events.error).toEqual([{ error: down, id: item.id }]);
		expect(events.failed).toEqual([]);
		expect(events.dsn).toEqual([]);
		expect(await store.get(item.id)).toBeDefined();
	});
}

function cancelledAtRecord(open: Open): void {
	test('an item cancelled before the failures are recorded, its lease still held, tells nothing', async () => {
		const { store: base, lose } = await open();
		const store = completing(base, async (target, id, owner, result) => {
			await target.cancel(id);
			return target.complete(id, owner, result);
		});
		const { queue, sender, events } = instance(store);
		const item = await queue.enqueue(MESSAGE, FROM_MARY);
		await lose(item.id);
		expect(await queue.deliverDue()).toBe(1);
		expect(events).toEqual({
			delivered: [],
			deferred: [],
			failed: [],
			dsn: [],
			error: [],
		});
		expect(sender.calls).toEqual([]);
		expect(await store.count()).toBe(0);
	});
}
