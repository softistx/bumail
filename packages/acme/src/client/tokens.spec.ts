import { describe, expect, test } from 'bun:test';
import { AcmeError } from '../errors';
import { Http01Tokens, REMOVE_GRACE_MS } from './tokens';

const never = new AbortController().signal;

describe('Http01Tokens', () => {
	test('removes each token after its set settled', async () => {
		const calls: string[] = [];
		const tokens = new Http01Tokens({
			async set(token) {
				await Bun.sleep(40);
				calls.push(`set ${token}`);
			},
			remove(token) {
				calls.push(`remove ${token}`);
			},
		});
		const aborted = AbortSignal.abort();
		await tokens.set('a', 'a.x', aborted).catch(() => {});
		expect(await tokens.removeAll()).toBeUndefined();
		expect(calls).toEqual(['set a', 'remove a']);
	});

	test('runs the removes in parallel, under one grace', async () => {
		let running = 0;
		let most = 0;
		const tokens = new Http01Tokens({
			set() {},
			async remove() {
				running++;
				most = Math.max(most, running);
				await Bun.sleep(30);
				running--;
			},
		});
		for (const token of ['a', 'b', 'c']) await tokens.set(token, '', never);
		const started = performance.now();
		expect(await tokens.removeAll()).toBeUndefined();
		expect(most).toBe(3);
		expect(performance.now() - started).toBeLessThan(80);
	});

	test('a set that never settles is TIMEOUT after the grace, and its remove still asked', async () => {
		const removed: string[] = [];
		const tokens = new Http01Tokens(
			{
				set: () => new Promise(() => {}),
				remove(token) {
					removed.push(token);
				},
			},
			30,
		);
		await tokens.set('a', '', AbortSignal.abort()).catch(() => {});
		const failure = await tokens.removeAll();
		const error = failure?.error as AcmeError;
		expect(error).toBeInstanceOf(AcmeError);
		expect(error.code).toBe('TIMEOUT');
		expect(error.message).toBe(
			'obtainCertificate(): http01.set("a") did not settle within 30 ms, so its token may stay served',
		);
		expect(removed).toEqual(['a']);
	});

	test('a remove that never settles is TIMEOUT after the grace; the others still run', async () => {
		const removed: string[] = [];
		const tokens = new Http01Tokens(
			{
				set() {},
				remove(token) {
					if (token === 'a') return new Promise<void>(() => {});
					removed.push(token);
					return undefined;
				},
			},
			30,
		);
		await tokens.set('a', '', never);
		await tokens.set('b', '', never);
		const error = (await tokens.removeAll())?.error as AcmeError;
		expect(error.message).toBe(
			'obtainCertificate(): http01.remove("a") did not settle within 30 ms',
		);
		expect(removed).toEqual(['b']);
	});

	test('a set that threw is still removed; a remove that throws is the failure', async () => {
		const tokens = new Http01Tokens({
			set() {
				throw new Error('down');
			},
			remove() {
				throw new Error('could not remove');
			},
		});
		await expect(tokens.set('a', '', never)).rejects.toThrow('down');
		const failure = await tokens.removeAll();
		expect(failure?.error).toEqual(new Error('could not remove'));
	});

	test(`the default grace is ${REMOVE_GRACE_MS} ms`, () => {
		expect(REMOVE_GRACE_MS).toBe(10_000);
	});

	test('a set that lands after the grace is removed once it lands', async () => {
		const served = new Set<string>();
		const tokens = new Http01Tokens(
			{
				async set(token) {
					await Bun.sleep(80);
					served.add(token);
				},
				remove(token) {
					served.delete(token);
				},
			},
			30,
		);
		await tokens.set('a', '', AbortSignal.abort()).catch(() => {});
		const error = (await tokens.removeAll())?.error as AcmeError;
		expect(error.code).toBe('TIMEOUT');
		await Bun.sleep(100);
		expect(served.size).toBe(0);
	});
});
