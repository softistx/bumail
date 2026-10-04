import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Directory } from './directory';
import { PASSWORD, seededDirectory } from './directory.fixtures';
import { FailureLimiter } from './limiter';
import { Gate } from './password';

const IP = '192.0.2.1';
const opened: Directory[] = [];
afterEach(() => {
	for (const directory of opened.splice(0)) directory.close();
});

async function directory(
	options: Parameters<typeof seededDirectory>[0] = {},
): Promise<Directory> {
	const seeded = await seededDirectory(options);
	opened.push(seeded);
	return seeded;
}

describe('authenticate', () => {
	test('answers the user for its password, any spelling of its address', async () => {
		const found = await (await directory()).authenticate(
			'Alice@Example.COM',
			PASSWORD,
			IP,
		);
		expect(found).toMatchObject({
			ok: true,
			user: { address: 'alice@example.com', disabled: false },
		});
		expect(JSON.stringify(found)).not.toContain('argon2');
	});

	test.each<[string, string, string, string]>([
		['a wrong password', 'alice@example.com', 'not the password', 'password'],
		['an unknown user', 'nobody@example.com', PASSWORD, 'unknown'],
		['a login that is no address', 'alice', PASSWORD, 'unknown'],
		['an alias', 'sales@example.com', PASSWORD, 'unknown'],
		['an empty password', 'alice@example.com', '', 'malformed'],
		[
			'a password over 1024 bytes',
			'alice@example.com',
			'x'.repeat(1025),
			'malformed',
		],
		['a login over 1024 bytes', 'a'.repeat(1025), PASSWORD, 'malformed'],
	])('refuses %s', async (_, login, password, reason) => {
		expect(await (await directory()).authenticate(login, password, IP)).toEqual(
			{
				ok: false,
				reason,
			} as never,
		);
	});

	test('refuses a disabled user, once its password is right', async () => {
		const dir = await directory();
		dir.users.setDisabled('alice@example.com', true);
		expect(await dir.authenticate('alice@example.com', PASSWORD, IP)).toEqual({
			ok: false,
			reason: 'disabled',
		});
		expect(
			await dir.authenticate('alice@example.com', 'wrong one', IP),
		).toEqual({
			ok: false,
			reason: 'password',
		});
	});

	test('blocks a client that failed too often, without verifying, even the right password', async () => {
		const limiter = new FailureLimiter({ maxFailures: 3 });
		const dir = await directory({ limiter });
		expect(dir.limiter).toBe(limiter);
		for (const login of [
			'alice@example.com',
			'nobody@example.com',
			'bob@example.com',
		]) {
			expect((await dir.authenticate(login, 'wrong guess', IP)).ok).toBe(false);
		}
		const verify = spyOn(Bun.password, 'verify');
		try {
			expect(await dir.authenticate('alice@example.com', PASSWORD, IP)).toEqual(
				{
					ok: false,
					reason: 'blocked',
				},
			);
			expect(verify).not.toHaveBeenCalled();
		} finally {
			verify.mockRestore();
		}
		expect(
			(await dir.authenticate('alice@example.com', PASSWORD, '192.0.2.2')).ok,
		).toBe(true);
	});

	test('runs at most maxVerifies verifies at once; the rest wait their turn', async () => {
		const dir = await directory({ maxVerifies: 2 });
		let running = 0;
		let most = 0;
		const original = Bun.password.verify.bind(Bun.password);
		const verify = spyOn(Bun.password, 'verify').mockImplementation(
			async (...args: Parameters<typeof Bun.password.verify>) => {
				running++;
				most = Math.max(most, running);
				try {
					return await original(...args);
				} finally {
					running--;
				}
			},
		);
		try {
			const results = await Promise.all(
				Array.from({ length: 7 }, (_, i) =>
					dir.authenticate(
						i % 2 === 0 ? 'alice@example.com' : 'nobody@example.com',
						PASSWORD,
						`198.51.100.${i}`,
					),
				),
			);
			expect(verify).toHaveBeenCalledTimes(7);
			expect(most).toBe(2);
			expect(results.map((result) => result.ok)).toEqual([
				true,
				false,
				true,
				false,
				true,
				false,
				true,
			]);
		} finally {
			verify.mockRestore();
		}
	});

	test('answers busy, uncounted, once the queue is full', async () => {
		const dir = await directory({ maxVerifies: 1, maxQueuedVerifies: 1 });
		const results = await Promise.all(
			[1, 2, 3].map(() =>
				dir.authenticate('alice@example.com', 'wrong guess', IP),
			),
		);
		expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual(
			['password', 'password', 'busy'],
		);
		expect(dir.limiter.blockedUntil(IP)).toBeUndefined();
	});

	test('takes about as long for an unknown user as for a wrong password', async () => {
		const dir = await directory({ maxVerifies: 1 });
		const time = async (login: string) => {
			const start = performance.now();
			await dir.authenticate(
				login,
				'wrong guess',
				`203.0.113.${(Math.random() * 250) | 0}`,
			);
			return performance.now() - start;
		};
		await time('nobody@example.com'); // the dummy hash is made once
		const known: number[] = [];
		const unknown: number[] = [];
		for (let i = 0; i < 5; i++) {
			known.push(await time('alice@example.com'));
			unknown.push(await time('nobody@example.com'));
		}
		const median = (values: number[]) =>
			values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
		const ratio = median(unknown) / median(known);
		// A verify of argon2id is tens of milliseconds; a lookup alone, microseconds.
		expect(median(known)).toBeGreaterThan(2);
		expect(ratio).toBeGreaterThan(0.5);
		expect(ratio).toBeLessThan(2);
	});
});

describe('Gate', () => {
	test('runs max tasks at once, in order, and refuses past maxQueued', async () => {
		const gate = new Gate(2, 2);
		const releases: (() => void)[] = [];
		const started: number[] = [];
		const task = (n: number) => () =>
			new Promise<number>((resolve) => {
				started.push(n);
				releases.push(() => resolve(n));
			});
		const runs = [1, 2, 3, 4].map((n) => gate.run(task(n)));
		await Bun.sleep(0);
		expect(started).toEqual([1, 2]);
		expect([gate.running, gate.queued, gate.full]).toEqual([2, 2, true]);
		expect(await gate.run(task(5))).toBeUndefined();
		releases.shift()?.();
		await Bun.sleep(0);
		expect(started).toEqual([1, 2, 3]);
		while (releases.length > 0) {
			releases.shift()?.();
			await Bun.sleep(0);
		}
		expect(await Promise.all(runs)).toEqual([
			{ value: 1 },
			{ value: 2 },
			{ value: 3 },
			{ value: 4 },
		]);
		expect([gate.running, gate.queued]).toEqual([0, 0]);
	});

	test('frees its place when a task throws', async () => {
		const gate = new Gate(1, 0);
		await expect(
			gate.run(() => Promise.reject(new Error('boom'))),
		).rejects.toThrow('boom');
		expect(await gate.run(async () => 1)).toEqual({ value: 1 });
	});
});
