import { expect, test } from 'bun:test';
import type { QueueStore } from '../contract/queue-store';
import type { QueueOptions } from '../queue/options';
import { createQueue } from '../queue/queue';
import {
	accepted,
	type Call,
	fakeClock,
	fakeSender,
	gate,
	MESSAGE,
	MINUTE,
	NO_DNS,
	recordEvents,
	reply,
	type Script,
	T0,
	until,
} from '../queue/queue.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

/** A queue on `store`: one instance of a server, with its own clock and sender. */
function instance(
	store: QueueStore,
	owner: string,
	script?: Script,
	options: Partial<QueueOptions> = {},
) {
	const clock = fakeClock();
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
	return { queue, clock, sender, events: recordEvents(queue) };
}

/** Delivers until neither instance claims anything more. */
async function drain(...queues: { deliverDue(): Promise<number> }[]) {
	for (;;) {
		const claimed = await Promise.all(queues.map((q) => q.deliverDue()));
		if (claimed.every((n) => n === 0)) return;
	}
}

const ITEMS = 200;

describePostgres('PostgresQueueStore under createQueue', (url) => {
	const { create, share } = temporaryStores(url);

	test('two instances on two connections deliver every item exactly once', async () => {
		const store = create();
		const slow = async (call: Call) => {
			await Bun.sleep(Math.random() * 3);
			return accepted(call.options);
		};
		const a = instance(store, 'a', slow, { concurrency: 4 });
		const b = instance(share(store), 'b', slow, { concurrency: 4 });
		const recipients = Array.from(
			{ length: ITEMS },
			(_, i) => `r${i}@d${i % 7}.example`,
		);
		for (const to of recipients) {
			await a.queue.enqueue(MESSAGE, { from: 'mary@example.net', to });
		}
		await drain(a.queue, b.queue);
		const sent = [...a.sender.calls, ...b.sender.calls].flatMap((c) => c.to);
		expect(sent.length).toBe(ITEMS);
		expect(new Set(sent)).toEqual(new Set(recipients));
		const delivered = [...a.events.delivered, ...b.events.delivered];
		expect(delivered.map((e) => e.recipient).sort()).toEqual(
			[...recipients].sort(),
		);
		expect(a.sender.calls.length).toBeGreaterThan(0);
		expect(b.sender.calls.length).toBeGreaterThan(0);
		expect([...a.events.error, ...b.events.error]).toEqual([]);
		expect(await store.count()).toBe(0);
	}, 30_000);

	test('an instance that stalls past its lease loses the item to another, and records nothing', async () => {
		const store = create();
		const held = gate();
		const stalled = instance(store, 'stalled', async (call) => {
			await held.opened;
			return accepted(call.options);
		});
		const later = reply(451, '4.3.0', 'Try later');
		const other = instance(share(store), 'other', (call) =>
			accepted(call.options, { 'joe@example.com': later }),
		);
		const item = await stalled.queue.enqueue(MESSAGE, {
			from: 'mary@example.net',
			to: 'joe@example.com',
		});
		const first = stalled.queue.deliverDue();
		await until(() => stalled.sender.calls.length === 1);
		expect((await store.get(item.id))?.lease?.owner).toBe('stalled');
		// The lease (10 minutes by default) still holds: nothing to claim.
		other.clock.advance(10 * MINUTE - 1);
		expect(await other.queue.deliverDue()).toBe(0);
		other.clock.advance(1);
		expect(await other.queue.deliverDue()).toBe(1);
		expect(other.events.deferred.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		held.open();
		await first;
		expect(stalled.events.delivered).toEqual([]);
		expect(stalled.events.error.map((e) => e.error)).toEqual([
			expect.objectContaining({ code: 'LEASE_LOST' }),
		]);
		const kept = await store.get(item.id);
		expect(kept?.recipients[0]?.status).toBe('deferred');
		expect(kept?.attempts).toBe(1);
		expect(kept?.lease).toBeUndefined();
	});

	test('a crashed instance’s claims are taken back once their leases expire', async () => {
		const store = create();
		const other = instance(share(store), 'other');
		for (let i = 0; i < 5; i++) {
			await other.queue.enqueue(MESSAGE, {
				from: 'mary@example.net',
				to: `r${i}@example.com`,
			});
		}
		for (let i = 0; i < 5; i++) {
			await store.claim({ owner: 'crashed', now: T0, leaseMs: MINUTE });
		}
		expect(await other.queue.deliverDue()).toBe(0);
		other.clock.advance(MINUTE);
		expect(await other.queue.deliverDue()).toBe(5);
		expect(other.events.delivered).toHaveLength(5);
		expect(await store.count()).toBe(0);
	});

	test('a reply cut at an emoji is kept: the item moves on, and the accepted recipient gets the message once', async () => {
		const store = create();
		const later = reply(451, '4.3.0', `${'a'.repeat(508)}😀 and more`);
		const { queue, clock, sender, events } = instance(store, 'w', (call) =>
			accepted(call.options, { 'ann@example.org': later }),
		);
		const item = await queue.enqueue(MESSAGE, {
			from: 'mary@example.net',
			to: ['joe@example.com', 'ann@example.org'],
		});
		expect(await queue.deliverDue()).toBe(1);
		expect(events.error).toEqual([]);
		const kept = await store.get(item.id);
		expect(kept?.attempts).toBe(1);
		expect(kept?.lease).toBeUndefined();
		expect(kept?.recipients.map((r) => r.status)).toEqual([
			'delivered',
			'deferred',
		]);
		expect(kept?.recipients[1]?.reply?.text).toBe(`${'a'.repeat(508)}...`);
		// Past any lease: nothing comes back to send joe the message again.
		clock.advance(29 * MINUTE);
		expect(await queue.deliverDue()).toBe(0);
		clock.advance(MINUTE);
		expect(await queue.deliverDue()).toBe(1);
		const toJoe = sender.calls.filter((c) => c.to.includes('joe@example.com'));
		expect(toJoe).toHaveLength(1);
	});

	test('enqueue keeps its limits and checks on PostgreSQL: nothing refused is stored', async () => {
		const store = create();
		const { queue } = instance(store, 'w', undefined, {
			limits: { maxMessageSize: 1024, maxItems: 1 },
		});
		const from = 'mary@example.net';
		await expect(
			queue.enqueue('Subject: x\n\nbare LF\r\n', {
				from,
				to: 'joe@example.com',
			}),
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			queue.enqueue(`Subject: x\r\n\r\n${'a'.repeat(2048)}\r\n`, {
				from,
				to: 'joe@example.com',
			}),
		).rejects.toMatchObject({ code: 'MESSAGE_TOO_BIG' });
		await expect(
			queue.enqueue(MESSAGE, { from, to: 'a,b@example.com' }),
		).rejects.toMatchObject({ code: 'INVALID' });
		expect(await store.count()).toBe(0);
		await queue.enqueue(MESSAGE, { from, to: 'joe@example.com' });
		await expect(
			queue.enqueue(MESSAGE, { from, to: 'ann@example.org' }),
		).rejects.toMatchObject({ code: 'QUEUE_FULL' });
		expect(await store.count()).toBe(1);
	});
});
