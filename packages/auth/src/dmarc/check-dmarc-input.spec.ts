import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { AuthError } from '../errors';
import {
	type CheckDmarcOptions,
	checkDmarc,
	type DmarcInput,
} from './check-dmarc';
import { messageFrom, published, spf } from './dmarc.fixtures';

const resolver = fixtureResolver(
	published('example.com', 'v=DMARC1; p=reject'),
);

function check(message: DmarcInput['message']) {
	return checkDmarc({ message, dkim: [] }, { resolver });
}

describe('the From domain (RFC 7489 §6.6.1)', () => {
	const evade = {
		domain: '',
		policy: 'none',
		disposition: 'reject',
		sampled: false,
	};

	test.each([
		['Subject: no From\r\n\r\nbody', 'the message has no From header'],
		[
			messageFrom('a@example.com', 'b@attacker.example'),
			'the message has more than one From header',
		],
		[
			messageFrom('a@example.com, b@attacker.example'),
			'From holds more than one address',
		],
		[messageFrom('just text'), 'From holds no address DMARC can read'],
		[
			messageFrom('a@[192.0.2.1]'),
			'the From domain "[192.0.2.1]" is not a domain name',
		],
	])('%#: %s', async (message, reason) => {
		expect(await check(message)).toEqual({
			result: 'permerror',
			reason,
			...evade,
		} as never);
	});

	test('a group with no address is none: there is no author to protect', async () => {
		expect(await check(messageFrom('undisclosed-recipients:;'))).toMatchObject({
			result: 'none',
			reason: 'From holds a group with no address',
			disposition: 'none',
		});
	});

	test('a group with one address is that address', async () => {
		expect(await check(messageFrom('team: a@example.com;'))).toMatchObject({
			domain: 'example.com',
			result: 'fail',
		});
	});

	test('a display name and angle brackets are read through', async () => {
		expect(
			await check(messageFrom('"Example, Inc." <billing@Example.COM>')),
		).toMatchObject({ domain: 'example.com', policyDomain: 'example.com' });
	});

	test('bytes and a stream are read like a string, the stream only to its header', async () => {
		const text = messageFrom('a@example.com');
		expect((await check(new TextEncoder().encode(text))).domain).toBe(
			'example.com',
		);
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(
					new TextEncoder().encode(pulled === 1 ? text : 'x'.repeat(1024)),
				);
			},
		});
		expect((await check(stream)).domain).toBe('example.com');
		expect(pulled).toBeLessThan(3);
	});

	test('a header past maxHeaderBytes cannot be evaluated', async () => {
		expect(
			await checkDmarc(
				{ message: messageFrom('a@example.com'), dkim: [] },
				{ resolver, maxHeaderBytes: 10 },
			),
		).toMatchObject({
			result: 'permerror',
			reason: 'the header is larger than maxHeaderBytes (10)',
			disposition: 'reject',
		});
	});

	test('a stream that fails is temperror', async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error('reset'));
			},
		});
		expect(await check(stream)).toMatchObject({
			result: 'temperror',
			reason: 'the message could not be read: Error: reset',
			disposition: 'none',
		});
	});
});

describe('checkDmarc refuses what the caller controls', () => {
	const input: DmarcInput = { message: messageFrom('a@example.com'), dkim: [] };

	test.each([
		[input, {}, 'checkDmarc(): resolver must be a Resolver'],
		[
			{ ...input, message: 42 },
			{ resolver },
			'checkDmarc(): message must be a Uint8Array, a string or a ReadableStream',
		],
		[
			{ ...input, dkim: undefined },
			{ resolver },
			'checkDmarc(): dkim must be the array verifyDkim returned',
		],
		[
			{ ...input, spf: { identity: 'mailfrom' } },
			{ resolver },
			'checkDmarc(): spf.result must be what checkSpf returned',
		],
		[
			{ ...input, spf: { ...spf('example.com'), identity: 'from' } },
			{ resolver },
			"checkDmarc(): spf.identity must be 'mailfrom' or 'helo', not from",
		],
		[
			input,
			{ resolver, random: 0.5 },
			'checkDmarc(): random must be a function',
		],
		[
			input,
			{ resolver, organizationalDomain: 'example.com' },
			'checkDmarc(): organizationalDomain must be a function',
		],
		[
			input,
			{ resolver, timeout: 0 },
			'checkDmarc(): timeout must be a positive integer of milliseconds, not 0',
		],
		[
			input,
			{ resolver, timeout: 2 ** 31 },
			'checkDmarc(): timeout must be at most 2147483647 ms, not 2147483648',
		],
		[
			input,
			{ resolver, maxHeaderBytes: 0 },
			'checkDmarc(): maxHeaderBytes must be an integer of at least 1, not 0',
		],
	])('%#: %s', async (given, options, message) => {
		const call = checkDmarc(given as DmarcInput, options as CheckDmarcOptions);
		await expect(call).rejects.toBeInstanceOf(AuthError);
		await expect(call).rejects.toMatchObject({
			code: 'INVALID_OPTION',
			message,
		});
	});
});
