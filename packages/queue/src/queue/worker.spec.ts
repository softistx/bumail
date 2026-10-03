import { describe, expect, test } from 'bun:test';
import { accepted, MESSAGE, MINUTE, setup, T0 } from './queue.fixtures';

/** A promise opened by hand. */
function gate() {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** Waits until `ready()`, a few seconds at most. */
async function until(ready: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 400; i++) {
		if (await ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('never ready');
}

const to = { from: 'mary@example.net', to: 'joe@example.com' };

describe('the worker', () => {
	test('start() delivers at once what is enqueued, not at the next poll', async () => {
		const { queue, events } = setup(undefined, { pollInterval: 60_000 });
		queue.start();
		await until(() => true);
		await queue.enqueue(MESSAGE, to);
		await until(() => events.delivered.length === 1);
		await queue.stop();
	});

	test('stop() lets a delivery under way end, its outcome recorded', async () => {
		const held = gate();
		const { queue, events, store } = setup(async (call) => {
			await held.opened;
			return accepted(call.options);
		});
		await queue.enqueue(MESSAGE, to);
		queue.start();
		await until(async () => (await store.list())[0]?.lease !== undefined);
		let stopped = false;
		const stopping = queue.stop().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopped).toBe(false);
		held.open();
		await stopping;
		expect(events.delivered).toHaveLength(1);
		expect(await store.count()).toBe(0);
	});

	test('stop() gives back an item waiting for its domain: no lease, due now, no attempt counted', async () => {
		const held = gate();
		const { queue, sender, store, clock } = setup(
			async (call) => {
				await held.opened;
				return accepted(call.options);
			},
			{ perDomain: 1 },
		);
		await queue.enqueue(MESSAGE, to);
		const second = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(() => sender.calls.length === 1);
		clock.advance(MINUTE);
		const stopping = queue.stop();
		held.open();
		await Promise.all([pass, stopping]);
		expect(sender.calls).toHaveLength(1);
		const left = await store.get(second.id);
		expect(left?.lease).toBeUndefined();
		expect(left).toMatchObject({ attempts: 0, nextAttemptAt: T0 + MINUTE });
		expect(left?.recipients[0]?.status).toBe('pending');
		expect(await queue.deliverDue()).toBe(1);
		expect(await store.count()).toBe(0);
	});

	test('the lease is renewed while the item is delivered', async () => {
		const held = gate();
		const { queue, store, clock } = setup(
			async (call) => {
				await held.opened;
				return accepted(call.options);
			},
			{ leaseMs: 1000 },
		);
		const item = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(async () => (await store.get(item.id))?.lease !== undefined);
		expect((await store.get(item.id))?.lease?.expiresAt).toBe(T0 + 1000);
		clock.advance(500);
		await until(
			async () => (await store.get(item.id))?.lease?.expiresAt === T0 + 1500,
		);
		held.open();
		await pass;
	});

	test('a lease another worker took is reported, and nothing is recorded twice', async () => {
		const held = gate();
		const { queue, store, clock, events } = setup(
			async (call) => {
				await held.opened;
				return accepted(call.options);
			},
			{ leaseMs: 60_000 },
		);
		const item = await queue.enqueue(MESSAGE, to);
		const pass = queue.deliverDue();
		await until(async () => (await store.get(item.id))?.lease !== undefined);
		clock.advance(2 * MINUTE);
		await store.claim({ owner: 'other', now: clock.now(), leaseMs: MINUTE });
		held.open();
		await pass;
		expect(events.delivered).toEqual([]);
		expect(events.error[0]?.error).toMatchObject({ code: 'LEASE_LOST' });
		expect((await store.get(item.id))?.lease?.owner).toBe('other');
	});

	test('a store that fails goes to the error event; the loop goes on', async () => {
		const { queue, store, events } = setup(undefined, { pollInterval: 5 });
		const claim = store.claim.bind(store);
		let failures = 2;
		store.claim = async (request) => {
			if (failures-- > 0) throw new Error('database is locked');
			return claim(request);
		};
		await queue.enqueue(MESSAGE, to);
		queue.start();
		await until(() => events.delivered.length === 1);
		await queue.stop();
		expect(events.error.map((e) => (e.error as Error).message)).toEqual([
			'database is locked',
			'database is locked',
		]);
	});
});

describe('the worker, at the edges', () => {
	test('start() called while stop() is under way starts again once it ends', async () => {
		const held = gate();
		const { queue, events, store } = setup(async (call) => {
			await held.opened;
			return accepted(call.options);
		});
		await queue.enqueue(MESSAGE, to);
		queue.start();
		await until(async () => (await store.list())[0]?.lease !== undefined);
		const stopping = queue.stop();
		queue.start();
		held.open();
		await stopping;
		await queue.enqueue(MESSAGE, to);
		await until(() => events.delivered.length === 2);
		await queue.stop();
	});

	test('a cancel during delivery: the outcome still told, no lease reported lost, no DSN', async () => {
		const held = gate();
		const { queue, events, store } = setup(async (call) => {
			await held.opened;
			return accepted(call.options, {
				'ann@example.com': { code: 550, text: 'no' },
			});
		});
		const item = await queue.enqueue(MESSAGE, {
			from: 'mary@example.net',
			to: ['joe@example.com', 'ann@example.com'],
		});
		const pass = queue.deliverDue();
		await until(async () => (await store.get(item.id))?.lease !== undefined);
		await queue.cancel(item.id);
		held.open();
		await pass;
		expect(events.error).toEqual([]);
		expect(events.delivered.map((e) => e.recipient)).toEqual([
			'joe@example.com',
		]);
		expect(events.failed.map((e) => e.recipient)).toEqual(['ann@example.com']);
		expect(events.dsn).toEqual([]);
	});

	test('a stop after a 4xx on one domain keeps the back-off for the whole item', async () => {
		const held = gate();
		const { queue, sender, store } = setup(
			async (call) => {
				if (call.to[0]?.endsWith('@slow.example')) await held.opened;
				if (call.to[0]?.endsWith('@busy.example')) {
					return accepted(call.options, {
						[call.to[0]]: { code: 451, status: '4.3.0', text: 'busy' },
					});
				}
				return accepted(call.options);
			},
			{ perDomain: 1 },
		);
		await queue.enqueue(MESSAGE, { from: '', to: 'a@slow.example' });
		const item = await queue.enqueue(MESSAGE, {
			from: '',
			to: ['b@busy.example', 'c@slow.example'],
		});
		const pass = queue.deliverDue();
		await until(() => sender.calls.length === 2);
		const stopping = queue.stop();
		held.open();
		await Promise.all([pass, stopping]);
		const left = await store.get(item.id);
		expect(left?.recipients.map((r) => r.status)).toEqual([
			'deferred',
			'pending',
		]);
		expect(left?.nextAttemptAt).toBe(T0 + 30 * MINUTE);
	});
});
