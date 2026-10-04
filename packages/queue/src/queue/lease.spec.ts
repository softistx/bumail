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
		expect((stalled.events.error[1]?.error as Error | undefined)?.message).toBe(
			`The lease on ${item.id} was lost while it was delivered, and the item is gone: finished by the worker that took it, the message then sent twice, or cancelled`,
		);
		expect(other.events.delivered).toHaveLength(1);
	});

	test('a known gap: clocks out of step, the item taken and finished between two renewals, reads as a cancel', async () => {
		const store = new MemoryQueueStore();
		const held = gate();
		// The other instance's clock runs ahead: by the first one's own clock
		// its lease still holds, and no renewal ran while the item was taken.
		const stalled = instance(store, 'stalled', fakeClock(), waitingFor(held));
		const otherClock = fakeClock();
		const other = instance(store, 'other', otherClock);
		const item = await stalled.queue.enqueue(MESSAGE, to);
		const first = stalled.queue.deliverDue();
		await until(() => stalled.sender.calls.length === 1);
		otherClock.advance(10 * MINUTE);
		expect(await other.queue.deliverDue()).toBe(1);
		expect(await store.get(item.id)).toBeUndefined();
		held.open();
		await first;
		expect(stalled.events.error).toEqual([]);
		expect(stalled.events.delivered.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
	});
});

/** `store`, its renewals counted as they start and as they settle. */
function counting(store: MemoryQueueStore) {
	const renew = store.renew.bind(store);
	/** What each renewal answered, in the order they settled. */
	const renewals: (boolean | Error)[] = [];
	const counts = { started: 0 };
	return {
		renewals,
		counts,
		/** Renewals answer through `answer`, given their index as started and the store's own. */
		renewWith(
			answer: (n: number, renew: () => Promise<boolean>) => Promise<boolean>,
		) {
			store.renew = async (...args) => {
				const n = counts.started++;
				try {
					const held = await answer(n, () => renew(...args));
					renewals.push(held);
					return held;
				} catch (error) {
					renewals.push(error as Error);
					throw error;
				}
			};
		},
	};
}

const lostOrCancelled = (id: string) =>
	`The lease on ${id} expired before its outcome was recorded, and the item is gone: lost to another worker that finished it, the message then sent twice, or cancelled`;

describe('a cancel, and renewals that fail', () => {
	test('a cancel under a lease that held, a renewal in between: told as cancelled, no LEASE_LOST', async () => {
		const store = new MemoryQueueStore();
		const { renewals, renewWith } = counting(store);
		renewWith((_, renew) => renew());
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
		// A renewal (every 333 ms) finds the item gone.
		await until(() => renewals.length === 1);
		expect(renewals).toEqual([false]);
		held.open();
		await pass;
		expect(events.error).toEqual([]);
		expect(events.delivered.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		expect(events.dsn).toEqual([]);
	});

	test('a cancel after the lease expired, no other worker: LEASE_LOST, lost or cancelled', async () => {
		const store = new MemoryQueueStore();
		const held = gate();
		const clock = fakeClock();
		const { queue, sender, events } = instance(
			store,
			'w',
			clock,
			waitingFor(held),
		);
		const item = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(() => sender.calls.length === 1);
		clock.advance(10 * MINUTE);
		await queue.cancel(item.id);
		held.open();
		await pass;
		expect(events.delivered).toEqual([]);
		expect(events.dsn).toEqual([]);
		expect(events.error.map((e) => e.error)).toEqual([
			expect.objectContaining({
				code: 'LEASE_LOST',
				message: lostOrCancelled(item.id),
			}),
		]);
	});

	test('renewals that fail keep the last expiry one set: a cancel before it is a cancel, after it lost or cancelled', async () => {
		for (const [advance, cancelled] of [
			[999, true],
			[1000, false],
		] as const) {
			const store = new MemoryQueueStore();
			const { renewals, renewWith } = counting(store);
			// The first renewal, at T0 + 500, holds until T0 + 1500; the next fail.
			renewWith(async (n, renew) => {
				if (n === 0) return renew();
				throw new Error('database is locked');
			});
			const held = gate();
			const clock = fakeClock();
			const { queue, sender, events } = instance(
				store,
				'w',
				clock,
				waitingFor(held),
				{ leaseMs: 1000 },
			);
			const item = await queue.enqueue(MESSAGE, to);
			const pass = queue.deliverDue();
			await until(() => sender.calls.length === 1);
			clock.advance(500);
			await until(() => renewals.length === 2);
			expect(renewals[0]).toBe(true);
			expect(renewals[1]).toBeInstanceOf(Error);
			clock.advance(advance);
			await queue.cancel(item.id);
			held.open();
			await pass;
			const lost = events.error
				.map((e) => e.error as Error)
				.filter((e) => e.message !== 'database is locked');
			if (cancelled) {
				expect(lost).toEqual([]);
				expect(events.delivered).toHaveLength(1);
			} else {
				expect(lost.map((e) => e.message)).toEqual([lostOrCancelled(item.id)]);
				expect(events.delivered).toEqual([]);
			}
		}
	});

	test('a lookup that fails after a refused renewal is told, and the delivery waits for it', async () => {
		const store = new MemoryQueueStore();
		const { renewals, renewWith } = counting(store);
		renewWith(async () => false);
		const looked = gate();
		const get = store.get.bind(store);
		let lookups = 0;
		const held = gate();
		const { queue, sender, events } = instance(
			store,
			'w',
			fakeClock(),
			waitingFor(held),
			{ leaseMs: 1000 },
		);
		const item = await queue.enqueue(MESSAGE, to);
		store.get = async () => {
			lookups++;
			await looked.opened;
			throw new Error('database is locked');
		};
		let done = false;
		const pass = queue.deliverDue().then(() => {
			done = true;
		});
		await until(() => sender.calls.length === 1);
		await until(() => renewals.length === 1 && lookups === 1);
		held.open();
		await until(async () => (await get(item.id)) === undefined);
		await Bun.sleep(20);
		expect(done).toBe(false);
		looked.open();
		await pass;
		expect(events.error.map((e) => (e.error as Error).message)).toEqual([
			'database is locked',
		]);
		expect(events.delivered).toHaveLength(1);
	});

	test('a held renewal that settles after the outcome is recorded keeps its expiry', async () => {
		const store = new MemoryQueueStore();
		const { renewals, counts, renewWith } = counting(store);
		const late = gate();
		// The first renewal, at T0 + 500, holds until T0 + 1500 but answers
		// only once the outcome is recorded; the next never answer.
		renewWith(async (n, renew) => {
			if (n > 0) return new Promise<boolean>(() => {});
			const held = await renew();
			await late.opened;
			return held;
		});
		const held = gate();
		const clock = fakeClock();
		const { queue, sender, events } = instance(
			store,
			'w',
			clock,
			waitingFor(held),
			{ leaseMs: 1000 },
		);
		const item = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(() => sender.calls.length === 1);
		clock.advance(500);
		await until(() => counts.started === 1);
		await queue.cancel(item.id);
		clock.advance(700);
		// The lookup after `complete`, once `recorded()` ran: the renewal
		// answers then, before the expiry is read.
		const get = store.get.bind(store);
		store.get = async (id) => {
			late.open();
			await until(() => renewals.length === 1);
			return get(id);
		};
		held.open();
		await pass;
		expect(renewals).toEqual([true]);
		// T0 + 1200 is before the renewal's T0 + 1500: a cancel.
		expect(events.error).toEqual([]);
		expect(events.delivered).toHaveLength(1);
	});

	test('renewals that settle out of order keep the latest expiry', async () => {
		const store = new MemoryQueueStore();
		const { renewals, counts, renewWith } = counting(store);
		const slow = gate();
		// The first renewal (T0 + 1500) answers after the second (T0 + 1800);
		// the ones after never answer.
		renewWith(async (n, renew) => {
			if (n > 1) return new Promise<boolean>(() => {});
			const held = await renew();
			if (n === 0) await slow.opened;
			return held;
		});
		const held = gate();
		const clock = fakeClock();
		const { queue, sender, events } = instance(
			store,
			'w',
			clock,
			waitingFor(held),
			{ leaseMs: 1000 },
		);
		const item = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(() => sender.calls.length === 1);
		clock.advance(500);
		await until(() => counts.started === 1);
		clock.advance(300);
		await until(() => renewals.length === 1);
		slow.open();
		await until(() => renewals.length === 2);
		expect(renewals).toEqual([true, true]);
		await queue.cancel(item.id);
		clock.advance(800);
		held.open();
		await pass;
		// T0 + 1600 is before T0 + 1800, though past T0 + 1500: a cancel.
		expect(events.error).toEqual([]);
		expect(events.delivered).toHaveLength(1);
	});
});
