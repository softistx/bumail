import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { AuthError } from '../errors';
import { type CheckSpfOptions, checkSpf, type SpfInput } from './check-spf';

const session: SpfInput = {
	ip: '192.0.2.10',
	mailFrom: 'joe@example.com',
	helo: 'mail.example.net',
};

describe('checkSpf refuses what the caller controls', () => {
	const resolver = fixtureResolver({});

	test.each([
		[
			{ ...session, ip: '192.0.2.300' },
			{},
			'checkSpf(): ip "192.0.2.300" is not an IPv4 or IPv6 address',
		],
		[
			{ ...session, ip: 'fe80::1%en0' },
			{},
			'checkSpf(): ip "fe80::1%en0" is not an IPv4 or IPv6 address',
		],
		[{ ...session, ip: undefined }, {}, 'checkSpf(): ip must be a string'],
		[{ ...session, ip: 3_221_225_994 }, {}, 'checkSpf(): ip must be a string'],
		[{ ...session, helo: undefined }, {}, 'checkSpf(): helo must be a string'],
		[
			{ ...session, mailFrom: null },
			{},
			'checkSpf(): mailFrom must be a string',
		],
		[
			session,
			{ timeout: 0 },
			'checkSpf(): timeout must be a positive integer of milliseconds, not 0',
		],
		[
			session,
			{ timeout: 2 ** 31 },
			'checkSpf(): timeout must be at most 2147483647 ms, not 2147483648',
		],
		[
			session,
			{ identity: 'from' },
			"checkSpf(): identity must be 'mailfrom' or 'helo', not from",
		],
		[
			session,
			{ resolver: undefined },
			'checkSpf(): resolver must be a Resolver',
		],
	])('%#', async (input, options, message) => {
		const error = await checkSpf(
			input as SpfInput,
			{
				resolver,
				...options,
			} as CheckSpfOptions,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AuthError);
		expect(error).toMatchObject({ code: 'INVALID_OPTION', message });
	});
});

test('takes a timeout up to 2^31 − 1 ms, the longest setTimeout waits', async () => {
	const got = await checkSpf(session, {
		resolver: fixtureResolver({
			'example.com': { txt: ['v=spf1 ip4:192.0.2.10 -all'] },
		}),
		timeout: 2_147_483_647,
	});
	expect(got.result).toBe('pass');
});
