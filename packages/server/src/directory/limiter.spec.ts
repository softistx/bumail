import { describe, expect, test } from 'bun:test';
import { ServerError } from '../errors';
import { clientKey, FailureLimiter } from './limiter';

/** A limiter on a clock the spec moves, in seconds. */
function clocked(options: { maxFailures?: number; maxClients?: number } = {}) {
	let now = 1_000_000;
	const limiter = new FailureLimiter({
		maxFailures: 3,
		windowSeconds: 60,
		...options,
		now: () => now,
	});
	return {
		limiter,
		advance(seconds: number) {
			now += seconds * 1000;
		},
		now: () => now,
	};
}

describe('clientKey', () => {
	test.each([
		['192.0.2.1', '192.0.2.1'],
		['::ffff:192.0.2.1', '192.0.2.1'],
		['::FFFF:192.0.2.1', '192.0.2.1'],
		['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
		['2001:db8:1:2::9', '2001:db8:1:2::/64'],
		['2001:0db8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
		['2001:db8::1', '2001:db8:0:0::/64'],
		['::1', '0:0:0:0::/64'],
		['::ffff:c000:201', '192.0.2.1'],
		['64:ff9b::c633:6401', '198.51.100.1'],
		['64:ff9b::198.51.100.1', '198.51.100.1'],
		['64:ff9b::c633:6402', '198.51.100.2'],
		['[2001:db8:1:2::9]', '2001:db8:1:2::/64'],
		['fe80::1%en0', 'fe80:0:0:0::/64'],
		['', undefined],
		['/run/bumail.sock', undefined],
		['not an address', undefined],
	])('%p counts as %p', (ip, key) => {
		expect(clientKey(ip)).toBe(key);
	});

	test('is undefined for no string at all', () => {
		expect(clientKey(undefined)).toBeUndefined();
		expect(clientKey(42 as unknown as string)).toBeUndefined();
	});
});

describe('FailureLimiter', () => {
	test('blocks a client at maxFailures within the window, and no other', () => {
		const { limiter } = clocked();
		for (let i = 0; i < 2; i++) limiter.fail('192.0.2.1');
		expect(limiter.blocked('192.0.2.1')).toBe(false);
		limiter.fail('192.0.2.1');
		expect(limiter.blocked('192.0.2.1')).toBe(true);
		expect(limiter.blocked('::ffff:192.0.2.1')).toBe(true);
		expect(limiter.blocked('192.0.2.2')).toBe(false);
	});

	test('counts an IPv6 /64 as one client', () => {
		const { limiter } = clocked();
		limiter.fail('2001:db8:1:2::1');
		limiter.fail('2001:db8:1:2::2');
		limiter.fail('2001:db8:1:2:aaaa::3');
		expect(limiter.blocked('2001:db8:1:2::ffff')).toBe(true);
		expect(limiter.blocked('2001:db8:1:3::1')).toBe(false);
	});

	test('is a sliding window: each failure ageing out gives back one try', () => {
		const { limiter, advance, now } = clocked();
		limiter.fail('192.0.2.1');
		advance(10);
		limiter.fail('192.0.2.1');
		advance(10);
		limiter.fail('192.0.2.1');
		expect(limiter.blockedUntil('192.0.2.1')).toBe(now() - 20_000 + 60_000);
		advance(39);
		expect(limiter.blocked('192.0.2.1')).toBe(true);
		advance(1);
		expect(limiter.blocked('192.0.2.1')).toBe(false);
		expect(limiter.blockedUntil('192.0.2.1')).toBeUndefined();
		limiter.fail('192.0.2.1');
		expect(limiter.blocked('192.0.2.1')).toBe(true);
		advance(10);
		expect(limiter.blocked('192.0.2.1')).toBe(false);
	});

	test('forgets a client once its failures are all past the window', () => {
		const { limiter, advance } = clocked();
		limiter.fail('192.0.2.1');
		expect(limiter.size).toBe(1);
		advance(60);
		expect(limiter.blocked('192.0.2.1')).toBe(false);
		expect(limiter.size).toBe(0);
	});

	test('remembers maxClients at most, forgetting the oldest below the limit, never a blocked one', () => {
		const { limiter } = clocked({ maxFailures: 2, maxClients: 2 });
		limiter.fail('192.0.2.1');
		limiter.fail('192.0.2.1');
		limiter.fail('192.0.2.2');
		limiter.fail('192.0.2.3');
		expect(limiter.size).toBe(2);
		expect(limiter.blocked('192.0.2.1')).toBe(true);
		expect(limiter.blockedUntil('192.0.2.2')).toBeUndefined();
	});

	test('with every client blocked, forgets the one whose block ends soonest, keeping the newcomer', () => {
		const { limiter, advance } = clocked({ maxFailures: 2, maxClients: 2 });
		limiter.fail('192.0.2.1');
		advance(1);
		limiter.fail('192.0.2.2');
		limiter.fail('192.0.2.2');
		limiter.fail('192.0.2.1');
		expect(limiter.blockedUntil('192.0.2.1')).toBeLessThan(
			limiter.blockedUntil('192.0.2.2') ?? 0,
		);
		limiter.fail('192.0.2.3');
		expect(limiter.size).toBe(2);
		expect(limiter.blocked('192.0.2.1')).toBe(false);
		expect(limiter.blocked('192.0.2.2')).toBe(true);
		limiter.fail('192.0.2.3');
		expect(limiter.blocked('192.0.2.3')).toBe(true);
	});

	test('a spray of malformed logins from many /64s neither evicts a blocked client nor fills the table', () => {
		const { limiter } = clocked({ maxFailures: 3, maxClients: 10 });
		for (let i = 0; i < 3; i++) limiter.fail('2001:db8:bad::1');
		expect(limiter.blocked('2001:db8:bad::1')).toBe(true);
		for (let i = 0; i < 5000; i++) {
			limiter.fail(`2001:db8:${(i % 65536).toString(16)}:${i >> 16}::1`, {
				create: false,
			});
		}
		expect(limiter.size).toBe(1);
		for (let i = 0; i < 5000; i++) {
			limiter.fail(`2001:db9:${(i % 65536).toString(16)}::1`);
		}
		expect(limiter.size).toBe(10);
		expect(limiter.blocked('2001:db8:bad::1')).toBe(true);
	});

	test('a malformed login counts against a client already known', () => {
		const { limiter } = clocked();
		limiter.fail('192.0.2.1', { create: false });
		expect(limiter.size).toBe(0);
		limiter.fail('192.0.2.1');
		limiter.fail('192.0.2.1', { create: false });
		limiter.fail('192.0.2.1', { create: false });
		expect(limiter.blocked('192.0.2.1')).toBe(true);
	});

	test('caps the logins under way per client as busy, never blocked', () => {
		const { limiter } = clocked({ maxFailures: 3 });
		expect(limiter.maxPending).toBe(3);
		expect([1, 2, 3, 4].map(() => limiter.begin('192.0.2.1'))).toEqual([
			'started',
			'started',
			'started',
			'busy',
		]);
		expect(limiter.blocked('192.0.2.1')).toBe(false);
		limiter.end('192.0.2.1', false);
		expect(limiter.begin('192.0.2.1')).toBe('started');
		limiter.end('192.0.2.1', true);
		limiter.end('192.0.2.1', true);
		// One failure left, one login under way: no room for another guess.
		expect(limiter.begin('192.0.2.1')).toBe('busy');
		limiter.end('192.0.2.1', true);
		expect(limiter.begin('192.0.2.1')).toBe('blocked');
	});

	test('maxPending defaults to 5, and never exceeds maxFailures', () => {
		expect(new FailureLimiter().maxPending).toBe(5);
		expect(
			new FailureLimiter({ maxFailures: 2, maxPending: 8 }).maxPending,
		).toBe(2);
	});

	test('does not limit a client that is no IP address', () => {
		const { limiter } = clocked({ maxFailures: 1 });
		for (let i = 0; i < 5; i++) {
			expect(limiter.begin('')).toBe('started');
			limiter.end('', true);
		}
		expect(limiter.blocked('')).toBe(false);
		expect(limiter.limits('')).toBe(false);
		expect(limiter.limits('192.0.2.1')).toBe(true);
		expect(limiter.size).toBe(0);
	});

	test('refuses options that are not positive integers', () => {
		for (const options of [
			{ maxFailures: 0 },
			{ windowSeconds: 1.5 },
			{ maxClients: -1 },
			{ maxPending: 0 },
		]) {
			expect(() => new FailureLimiter(options)).toThrow(ServerError);
		}
	});
});
