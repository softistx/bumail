import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import { Authenticator } from './authenticate';
import { Directory } from './directory';
import { PASSWORD, seededDirectory } from './directory.fixtures';
import { Gate } from './gate';
import { FailureLimiter } from './limiter';

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

	test('verifies no more than maxFailures guesses sent at once from one client', async () => {
		const dir = await directory({
			limiter: new FailureLimiter({ maxFailures: 5 }),
		});
		const verify = spyOn(Bun.password, 'verify');
		try {
			const guesses = await Promise.all(
				Array.from({ length: 30 }, () =>
					dir.authenticate('alice@example.com', 'wrong guess', IP),
				),
			);
			expect(verify).toHaveBeenCalledTimes(5);
			const reasons = guesses.map((result) =>
				result.ok ? 'ok' : result.reason,
			);
			expect(reasons.filter((reason) => reason === 'password').length).toBe(5);
			expect(reasons.filter((reason) => reason === 'busy').length).toBe(25);
			// Sent in turn instead, the sixth guess on would be blocked: as many verified.
			expect(await dir.authenticate('alice@example.com', PASSWORD, IP)).toEqual(
				{
					ok: false,
					reason: 'blocked',
				},
			);
		} finally {
			verify.mockRestore();
		}
	});

	test('never refuses 20 correct logins sent at once from one client as blocked', async () => {
		const dir = await directory({ cacheSeconds: 0 });
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				dir.authenticate('alice@example.com', PASSWORD, IP),
			),
		);
		const reasons = results.map((result) => (result.ok ? 'ok' : result.reason));
		expect(reasons.filter((reason) => reason === 'ok').length).toBeGreaterThan(
			0,
		);
		expect(
			reasons.every((reason) => reason === 'ok' || reason === 'busy'),
		).toBe(true);
		expect(dir.limiter.blocked(IP)).toBe(false);
		// Once remembered, they all pass, without a verify.
		const cached = await directory();
		await cached.authenticate('alice@example.com', PASSWORD, IP);
		const again = await Promise.all(
			Array.from({ length: 20 }, () =>
				cached.authenticate('Alice@example.com', PASSWORD, IP),
			),
		);
		expect(again.every((result) => result.ok)).toBe(true);
	});

	test('remembers a verified login, until the user changes in any process', async () => {
		const file = join(tempDir(), 'directory.sqlite');
		const server = Directory.open({ file });
		const command = Directory.open({ file });
		opened.push(server, command);
		command.domains.add('example.com');
		await command.users.add('alice@example.com', PASSWORD);
		const verify = spyOn(Bun.password, 'verify');
		const login = (password = PASSWORD) =>
			server.authenticate('alice@example.com', password, IP);
		try {
			expect((await login()).ok).toBe(true);
			expect((await login()).ok).toBe(true);
			expect(verify).toHaveBeenCalledTimes(1);
			expect((await login('wrong guess')).ok).toBe(false);
			expect(verify).toHaveBeenCalledTimes(2);

			command.users.setDisabled('alice@example.com', true);
			expect(await login()).toEqual({ ok: false, reason: 'disabled' });
			command.users.setDisabled('alice@example.com', false);
			expect((await login()).ok).toBe(true);

			await command.users.setPassword(
				'alice@example.com',
				'a brand new passphrase',
			);
			expect(await login()).toEqual({ ok: false, reason: 'password' });
			expect((await login('a brand new passphrase')).ok).toBe(true);

			command.users.remove('alice@example.com');
			expect(await login('a brand new passphrase')).toEqual({
				ok: false,
				reason: 'unknown',
			});
			await command.users.add('alice@example.com', 'someone else entirely');
			expect((await login('a brand new passphrase')).ok).toBe(false);
		} finally {
			verify.mockRestore();
		}
	});

	test('does not limit, and says so once, a login from no IP address', async () => {
		let told = 0;
		const dir = await directory({
			limiter: new FailureLimiter({ maxFailures: 1 }),
			onUnlimited: () => told++,
		});
		for (let i = 0; i < 3; i++) {
			expect(
				await dir.authenticate('alice@example.com', 'wrong guess', ''),
			).toEqual({
				ok: false,
				reason: 'password',
			});
		}
		expect(told).toBe(1);
	});

	test('a malformed login is never counted: it neither blocks nor keeps a client remembered', async () => {
		let now = 1_000_000;
		const dir = await directory({
			limiter: new FailureLimiter({
				maxFailures: 2,
				windowSeconds: 60,
				now: () => now,
			}),
		});
		for (let i = 0; i < 5; i++) {
			expect(await dir.authenticate('alice@example.com', '', IP)).toEqual({
				ok: false,
				reason: 'malformed',
			});
		}
		expect(dir.limiter.size).toBe(0);
		await dir.authenticate('alice@example.com', 'wrong guess', IP);
		now += 59_000;
		for (let i = 0; i < 5; i++) {
			await dir.authenticate('a'.repeat(1025), 'wrong guess', IP);
			await dir.authenticate('alice@example.com', '', IP);
		}
		expect(dir.limiter.blocked(IP)).toBe(false);
		expect(dir.limiter.blockedUntil(IP)).toBeUndefined();
		expect(dir.limiter.limits(IP)).toBe(true);
		now += 2_000;
		// The one real failure aged out: the malformed logins kept nothing.
		expect(dir.limiter.blocked(IP)).toBe(false);
		await dir.authenticate('alice@example.com', '', IP);
		expect(dir.limiter.size).toBe(0);
	});

	test('counts no failure when the lookup throws before any verify answered', async () => {
		const limiter = new FailureLimiter({ maxFailures: 1 });
		const auth = new Authenticator(
			{
				find: () => {
					throw new ServerError('UNAVAILABLE', 'the directory failed');
				},
				version: () => undefined,
			},
			{ limiter },
		);
		for (let i = 0; i < 3; i++) {
			await expect(
				auth.authenticate('alice@example.com', 'wrong guess', IP),
			).rejects.toThrow('the directory failed');
		}
		expect(limiter.blocked(IP)).toBe(false);
		expect(limiter.size).toBe(0);
		expect(limiter.begin(IP)).toBe('started');
	});

	test('logs in with a spelling whose lowercase NFC decomposes, as it was added', async () => {
		const dir = await directory();
		const spelling = 'T\u0308om@example.com';
		const user = await dir.users.add(spelling, PASSWORD);
		expect(user.address).toBe('\u1e97om@example.com');
		expect((await dir.authenticate(spelling, PASSWORD, IP)).ok).toBe(true);
		expect(dir.users.get(spelling)?.address).toBe(user.address);
		expect(dir.users.remove(spelling).address).toBe(user.address);
	});

	test('takes a password typed in another Unicode form', async () => {
		const dir = await directory();
		await dir.users.add('carol@example.com', 'caf\u00e9 au lait, please');
		expect(
			(
				await dir.authenticate(
					'carol@example.com',
					'cafe\u0301 au lait, please',
					IP,
				)
			).ok,
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
