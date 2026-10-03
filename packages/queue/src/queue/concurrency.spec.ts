import { describe, expect, test } from 'bun:test';
import { MemoryQueueStore } from '../memory/store';
import { createQueue } from './queue';
import {
	accepted,
	type Call,
	fakeClock,
	fakeSender,
	MESSAGE,
	NO_DNS,
	recordEvents,
	setup,
} from './queue.fixtures';

/** A sender that holds every session a moment, counting how many are open at once, overall and per domain. */
function counting() {
	let open = 0;
	let most = 0;
	const perDomain = new Map<string, number>();
	let mostPerDomain = 0;
	const script = async (call: Call) => {
		const domain = call.to[0]?.split('@')[1] ?? '';
		open++;
		perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
		most = Math.max(most, open);
		mostPerDomain = Math.max(mostPerDomain, perDomain.get(domain) ?? 0);
		await new Promise((resolve) => setTimeout(resolve, 2));
		open--;
		perDomain.set(domain, (perDomain.get(domain) ?? 1) - 1);
		return accepted(call.options);
	};
	return {
		script,
		most: () => most,
		mostPerDomain: () => mostPerDomain,
	};
}

describe('concurrency', () => {
	test('at most `concurrency` items at once', async () => {
		const count = counting();
		const { queue, sender } = setup(count.script, {
			concurrency: 3,
			perDomain: 100,
		});
		for (let i = 0; i < 12; i++) {
			await queue.enqueue(MESSAGE, { from: '', to: `r${i}@d${i}.example` });
		}
		expect(await queue.deliverDue()).toBe(12);
		expect(sender.calls).toHaveLength(12);
		expect(count.most()).toBe(3);
	});

	test('at most `perDomain` sessions at once to one domain', async () => {
		const count = counting();
		const { queue, sender } = setup(count.script, {
			concurrency: 10,
			perDomain: 2,
		});
		for (let i = 0; i < 8; i++) {
			await queue.enqueue(MESSAGE, { from: '', to: `r${i}@busy.example` });
			await queue.enqueue(MESSAGE, { from: '', to: `r${i}@other${i}.example` });
		}
		await queue.deliverDue();
		expect(sender.calls).toHaveLength(16);
		expect(count.mostPerDomain()).toBe(2);
		expect(count.most()).toBeGreaterThan(2);
	});

	test('several queues on one store deliver each item once', async () => {
		const store = new MemoryQueueStore();
		const clock = fakeClock();
		const sender = fakeSender(async (call) => {
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
			return accepted(call.options);
		});
		const queues = Array.from({ length: 4 }, (_, i) =>
			createQueue({
				store,
				hostname: 'mail.example.net',
				resolver: NO_DNS,
				clock,
				send: sender.send,
				owner: `worker-${i}`,
				concurrency: 2,
			}),
		);
		const delivered = queues.map((queue) => recordEvents(queue).delivered);
		for (let i = 0; i < 40; i++) {
			await queues[0]?.enqueue(MESSAGE, { from: '', to: `r${i}@example.com` });
		}
		const claimed = await Promise.all(queues.map((q) => q.deliverDue()));
		expect(claimed.reduce((a, b) => a + b, 0)).toBe(40);
		expect(sender.calls).toHaveLength(40);
		const recipients = delivered.flat().map((e) => e.recipient);
		expect(new Set(recipients).size).toBe(40);
		expect(await store.count()).toBe(0);
	});
});
