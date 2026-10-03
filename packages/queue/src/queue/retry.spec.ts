import { describe, expect, test } from 'bun:test';
import { SmtpError } from '@bumail/smtp/client';
import { MemoryQueueStore } from '../memory/store';
import {
	accepted,
	DAY,
	HOUR,
	MINUTE,
	reply,
	setup,
	T0,
} from './queue.fixtures';
import { nextAttemptAt, retryDelay } from './retry';
import { settingsOf } from './settings';

const defaults = settingsOf({
	store: new MemoryQueueStore(),
	hostname: 'mail.example.net',
	route: { host: 'relay.example.net' },
}).retry;

const busy = () =>
	new SmtpError('REFUSED', 'mx.example.com refused MAIL FROM: 451 busy', {
		reply: reply(451, '4.3.0', 'Try again later'),
	});

describe('RFC 5321 §4.5.4.1: the retry schedule', () => {
	test('"the retry interval SHOULD be at least 30 minutes": the first wait is 30 minutes', () => {
		expect(defaults.first).toBe(30 * MINUTE);
		expect(retryDelay(1, defaults, () => 0)).toBe(30 * MINUTE);
	});

	test('each wait doubles, up to 4 hours', () => {
		const waits = [1, 2, 3, 4, 5, 6].map((n) =>
			retryDelay(n, defaults, () => 0),
		);
		expect(waits).toEqual([
			30 * MINUTE,
			HOUR,
			2 * HOUR,
			4 * HOUR,
			4 * HOUR,
			4 * HOUR,
		]);
	});

	test('the jitter only adds, up to a tenth: never sooner than the floor', () => {
		expect(retryDelay(1, defaults, () => 1)).toBe(33 * MINUTE);
		expect(retryDelay(1, defaults, () => 0.5)).toBe(31.5 * MINUTE);
	});

	test('"give-up time generally needs to be at least 4-5 days": 5 days by default', () => {
		expect(defaults.giveUpAfter).toBe(5 * DAY);
		expect(nextAttemptAt(T0, T0 + 5 * DAY - 1, 9, defaults, () => 0)).toBe(
			T0 + 5 * DAY,
		);
		expect(
			nextAttemptAt(T0, T0 + 5 * DAY, 9, defaults, () => 0),
		).toBeUndefined();
	});

	test('the schedule is configurable, and checked', () => {
		const make = (retry: object) =>
			settingsOf({
				store: new MemoryQueueStore(),
				hostname: 'mail.example.net',
				route: { host: 'relay.example.net' },
				retry,
			}).retry;
		expect(make({ first: 1000, factor: 3, max: 5000 })).toMatchObject({
			first: 1000,
			factor: 3,
			max: 5000,
		});
		expect(() => make({ first: 0 })).toThrow('retry.first must be an integer');
		expect(() => make({ first: 2000, max: 1000 })).toThrow('retry.max');
		expect(() => make({ jitter: 2 })).toThrow('retry.jitter');
	});
});

describe('a 4xx is tried again', () => {
	test('deferred with its reply, not claimed before its time, delivered after', async () => {
		const { queue, clock, sender, events, store } = setup((call, index) =>
			index === 0 ? busy() : accepted(call.options),
		);
		const item = await queue.enqueue('Subject: x\r\n\r\ny\r\n', {
			from: 'mary@example.net',
			to: 'joe@example.com',
		});
		await queue.deliverDue();
		expect(events.deferred).toEqual([
			{
				id: item.id,
				from: 'mary@example.net',
				recipient: 'joe@example.com',
				reply: { code: 451, status: '4.3.0', text: 'Try again later' },
				attempts: 1,
				nextAttemptAt: T0 + 30 * MINUTE,
			},
		]);
		const stored = await store.get(item.id);
		expect(stored?.recipients[0]).toMatchObject({
			status: 'deferred',
			updatedAt: T0,
		});
		clock.advance(30 * MINUTE - 1);
		expect(await queue.deliverDue()).toBe(0);
		clock.advance(1);
		expect(await queue.deliverDue()).toBe(1);
		expect(sender.calls.length).toBe(2);
		expect(events.delivered[0]).toMatchObject({ attempts: 2 });
		expect(await store.count()).toBe(0);
	});

	test('a recipient still deferred after 5 days fails, as X.4.7, with a DSN', async () => {
		const { queue, clock, sender, events, store } = setup(() => busy(), {
			dsn: { delayAfter: false },
		});
		await queue.enqueue('Subject: x\r\n\r\ny\r\n', {
			from: 'mary@example.net',
			to: 'joe@example.com',
		});
		const times: number[] = [];
		for (let i = 0; i < 100 && (await store.count()) > 0; i++) {
			const [next] = await store.list();
			if (!next || next.from === '') break;
			clock.advance(next.nextAttemptAt - clock.now());
			times.push(clock.now() - T0);
			await queue.deliverDue();
		}
		expect(times.at(-1)).toBe(5 * DAY);
		expect(sender.calls.length).toBe(times.length + 1);
		expect(events.failed).toHaveLength(1);
		expect(events.failed[0]?.reply).toMatchObject({
			code: 451,
			status: '4.4.7',
			text: 'Try again later',
		});
		expect(events.dsn).toMatchObject([
			{ kind: 'failed', to: 'mary@example.net' },
		]);
	});
});
