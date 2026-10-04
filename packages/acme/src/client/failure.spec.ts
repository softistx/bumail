import { describe, expect, test } from 'bun:test';
import { untilAborted } from './failure';
import { MAX_POLL_DELAY_MS } from './options';
import { pollDelay } from './poll';

describe('untilAborted', () => {
	test('settles as the promise does while the signal holds', async () => {
		const signal = new AbortController().signal;
		expect(await untilAborted(Promise.resolve(1), signal)).toBe(1);
		expect(await untilAborted(2, signal)).toBe(2);
		await expect(
			untilAborted(Promise.reject(new Error('no')), signal),
		).rejects.toThrow('no');
	});

	test('rejects with the reason as soon as the signal fires, the promise pending', async () => {
		const controller = new AbortController();
		const pending = untilAborted(new Promise(() => {}), controller.signal);
		controller.abort(new Error('stop'));
		await expect(pending).rejects.toThrow('stop');
		await expect(untilAborted(1, controller.signal)).rejects.toThrow('stop');
	});
});

describe('pollDelay', () => {
	test('Retry-After clamped from the interval to a minute', () => {
		expect(pollDelay(undefined, 1000)).toBe(1000);
		expect(pollDelay(0, 1000)).toBe(1000);
		expect(pollDelay(3, 1000)).toBe(3000);
		expect(pollDelay(86_400, 1000)).toBe(MAX_POLL_DELAY_MS);
	});
});
