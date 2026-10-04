import { describe, expect, test } from 'bun:test';
import type { QueueStore } from '../contract/queue-store';
import { MemoryQueueStore } from '../memory/store';
import type { QueueOptions } from './options';
import { createQueue } from './queue';
import {
	accepted,
	fakeClock,
	fakeSender,
	gate,
	MESSAGE,
	MINUTE,
	NO_DNS,
	recordEvents,
	type Script,
	until,
} from './queue.fixtures';

type Clock = ReturnType<typeof fakeClock>;

/** A queue on `store`: one instance of a server, with its own sender, on `clock`. */
function instance(
	store: QueueStore,
	owner: string,
	clock: Clock,
	script?: Script,
	options: Partial<QueueOptions> = {},
) {
	const sender = fakeSender(script);
	const queue = createQueue({
		store,
		hostname: 'mail.example.net',
		resolver: NO_DNS,
		clock,
		send: sender.send,
		random: () => 0,
		owner,
		...options,
	});
	return { queue, sender, events: recordEvents(queue) };
}

/** A sender that waits for `held` to open, then accepts every recipient. */
const waitingFor =
	(held: ReturnType<typeof gate>): Script =>
	async (call) => {
		await held.opened;
		return accepted(call.options);
	};

const to = { from: 'mary@example.net', to: 'joe@example.com' };

describe('a lease lost to an instance that finished the item', () => {
	test('a stall past the lease, the other instance delivering and dropping the item: LEASE_LOST, no outcome told', async () => {
		const store = new MemoryQueueStore();
		const clock = fakeClock();
		const held = gate();
		const stalled = instance(store, 'stalled', clock, waitingFor(held));
		const other = instance(store, 'other', clock);
		const item = await stalled.queue.enqueue(MESSAGE, to);
		const first = stalled.queue.deliverDue();
		await until(() => stalled.sender.calls.length === 1);
		// The lease (10 minutes by default) expires; no renewal ran meanwhile.
		clock.advance(10 * MINUTE);
		expect(await other.queue.deliverDue()).toBe(1);
		expect(other.events.delivered.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		expect(await store.get(item.id)).toBeUndefined();
		held.open();
		await first;
		expect(stalled.events.delivered).toEqual([]);
		expect(stalled.events.dsn).toEqual([]);
		expect(stalled.events.error).toHaveLength(1);
		expect(stalled.events.error[0]).toMatchObject({
			id: item.id,
			error: { code: 'LEASE_LOST' },
		});
		const message = (stalled.events.error[0]?.error as Error | undefined)
			?.message;
		expect(message).toContain('expired before its outcome was recorded');
		expect(message).toContain('sent twice, or cancelled');
		expect(other.events.error).toEqual([]);
	});

	test('a renewal that found the lease taken, the taker then finishing: LEASE_LOST twice, no outcome told', async () => {
		const store = new MemoryQueueStore();
		const held = gate();
		const taking = gate();
		// The other instance's clock runs ahead: it claims while the first one's
		// own clock says its lease still holds, so only the renewal can tell.
		const stalledClock = fakeClock();
		const otherClock = fakeClock();
		const stalled = instance(store, 'stalled', stalledClock, waitingFor(held), {
			leaseMs: 1000,
		});
		const other = instance(store, 'other', otherClock, waitingFor(taking), {
			leaseMs: 1000,
		});
		const item = await stalled.queue.enqueue(MESSAGE, to);
		const first = stalled.queue.deliverDue();
		await until(() => stalled.sender.calls.length === 1);
		otherClock.advance(MINUTE);
		const second = other.queue.deliverDue();
		await until(() => other.sender.calls.length === 1);
		expect((await store.get(item.id))?.lease?.owner).toBe('other');
		await until(() => stalled.events.error.length === 1);
		taking.open();
		await second;
		expect(await store.get(item.id)).toBeUndefined();
		held.open();
		await first;
		expect(stalled.events.delivered).toEqual([]);
		expect(stalled.events.error.map((e) => e.error)).toEqual([
			expect.objectContaining({
				code: 'LEASE_LOST',
				message: `The lease on ${item.id} was lost while it was delivered`,
			}),
			expect.objectContaining({ code: 'LEASE_LOST' }),
		]);
		expect(
			(stalled.events.error[1]?.error as Error | undefined)?.message,
		).toContain('the worker that took it has finished it');
		expect(other.events.delivered).toHaveLength(1);
	});

	test('a cancel under a lease that held, a renewal in between: told as cancelled, no LEASE_LOST', async () => {
		const store = new MemoryQueueStore();
		const held = gate();
		const { queue, sender, events } = instance(
			store,
			'w',
			fakeClock(),
			waitingFor(held),
			{ leaseMs: 1000 },
		);
		const item = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(() => sender.calls.length === 1);
		await queue.cancel(item.id);
		// A renewal (every 333 ms) runs, and finds the item gone.
		await Bun.sleep(400);
		held.open();
		await pass;
		expect(events.error).toEqual([]);
		expect(events.delivered.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		expect(events.dsn).toEqual([]);
	});
});
