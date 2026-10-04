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
		['[2001:db8:1:2::9]', '2001:db8:1:2::/64'],
		['fe80::1%en0', 'fe80:0:0:0::/64'],
		['', ''],
		['/run/bumail.sock', '/run/bumail.sock'],
	])('%p counts as %p', (ip, key) => {
		expect(clientKey(ip)).toBe(key);
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

	test('remembers maxClients at most, forgetting the one that failed longest ago', () => {
		const { limiter } = clocked({ maxFailures: 1, maxClients: 2 });
		limiter.fail('192.0.2.1');
		limiter.fail('192.0.2.2');
		limiter.fail('192.0.2.1');
		limiter.fail('192.0.2.3');
		expect(limiter.size).toBe(2);
		expect(limiter.blocked('192.0.2.2')).toBe(false);
		expect(limiter.blocked('192.0.2.1')).toBe(true);
		expect(limiter.blocked('192.0.2.3')).toBe(true);
	});

	test('refuses options that are not positive integers', () => {
		for (const options of [
			{ maxFailures: 0 },
			{ windowSeconds: 1.5 },
			{ maxClients: -1 },
		]) {
			expect(() => new FailureLimiter(options)).toThrow(ServerError);
		}
	});
});
