import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { keyPair, unsigned } from './dkim.fixtures';
import { signDkim } from './sign';
import { verifyDkim } from './verify';

const NOW = 1_700_000_000_000;

/** A message signed with `headers` (the default when left out), and the resolver that holds its key. */
async function signed(headers?: string[]) {
	const { privateKey, record } = await keyPair('ed25519-sha256');
	const signature = await signDkim(unsigned(), {
		domain: 'example.com',
		selector: 'sel',
		privateKey,
		now: () => NOW,
		...(headers === undefined ? {} : { headers }),
	});
	const resolver = fixtureResolver({
		'sel._domainkey.example.com': { txt: [record] },
	});
	const verify = async (message: string) =>
		(await verifyDkim(message, { resolver, now: () => NOW }))[0];
	return { message: signature + unsigned(), verify };
}

describe('over-signing (RFC 6376 §5.4.2): a field added on top', () => {
	test('a From the signature does not cover is policy, not a pass', async () => {
		const { message, verify } = await signed(['from', 'to', 'subject']);
		expect((await verify(message))?.result).toBe('pass');
		const lookups = fixtureResolver({});
		const [result] = await verifyDkim(
			`From: mallory@example.net\r\n${message}`,
			{ resolver: lookups, now: () => NOW },
		);
		expect(result).toMatchObject({
			result: 'policy',
			reason: 'the message has a From the signature does not cover',
			domain: 'example.com',
		});
		expect(lookups.queries).toHaveLength(0);
	});

	test('a From added below the signed one is policy too', async () => {
		const { message, verify } = await signed(['from', 'to', 'subject']);
		expect(
			await verify(message.replace('To:', 'From: mallory@example.net\r\nTo:')),
		).toMatchObject({
			result: 'policy',
			reason: 'the message has a From the signature does not cover',
		});
	});

	test('the default signature over-signs From, Subject, To and Date: each added one fails', async () => {
		const { message, verify } = await signed();
		expect((await verify(message))?.result).toBe('pass');
		for (const field of [
			'From: mallory@example.net',
			'Subject: Your invoice',
			'To: someone@example.org',
			'Date: Mon, 1 Jan 2024 00:00:00 +0000',
		]) {
			expect(await verify(`${field}\r\n${message}`)).toMatchObject({
				result: 'fail',
				reason: 'signature did not verify',
			});
		}
	});
});
