import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { checkDmarc } from './check-dmarc';
import { dkim, messageFrom, published } from './dmarc.fixtures';
import { fromMailbox } from './from-mailbox';

// good.example is the brand a forger wants shown; evil.example is the
// forger's own domain, with a policy it controls and a DKIM key it signs with.
const resolver = fixtureResolver({
	...published('good.example', 'v=DMARC1; p=reject'),
	...published('evil.example', 'v=DMARC1; p=none'),
});

function check(message: string) {
	return checkDmarc({ message, dkim: [dkim('evil.example')] }, { resolver });
}

const refused = {
	result: 'permerror',
	domain: '',
	policy: 'none',
	disposition: 'reject',
	sampled: false,
};

describe('a From that a reader and DMARC could read apart (RFC 7489 §6.6.1)', () => {
	test.each([
		[
			'an address in an unquoted display name',
			'a@good.example <x@evil.example>',
		],
		['two angle addresses', '<x@evil.example> <a@good.example>'],
		['an addr-spec before an angle address', 'x@evil.example <a@good.example>'],
		['text after the angle address', '<x@evil.example> a@good.example'],
		['a stray >', 'x@evil.example> a@good.example'],
		['an unclosed angle address', 'Good <a@good.example'],
		['an unterminated quoted-string', '"a@good.example <x@evil.example>'],
		['an unterminated comment', 'x@evil.example (a@good.example'],
		['a stray )', 'x@evil.example) a@good.example'],
		['two @ in the address', 'x@evil.example@good.example'],
		['an obs-route', '<@evil.example:a@good.example>'],
		['a bare CR', 'x@evil.example\ra@good.example'],
		['a NUL', 'a@good.example\0x@evil.example'],
		['an escape outside quotes', 'a\\@good.example'],
		['a domain ending in a dot', 'a@good.example.'],
		['an empty label', 'a@good..example'],
		['a quoted domain', 'a@"good.example"'],
		['a semicolon list', 'a@good.example; x@evil.example'],
		['an empty list element', 'a@good.example,'],
		['a leading empty list element', ', a@good.example'],
	])('%s is permerror, to reject: %s', async (_, from) => {
		expect(await check(messageFrom(from))).toEqual({
			...refused,
			reason: 'From does not parse as one mailbox',
		} as never);
	});

	test.each([
		['two mailboxes', 'a@good.example, x@evil.example'],
		['two named mailboxes', 'Good <a@good.example>, Evil <x@evil.example>'],
		['a comma outside a quoted name', 'Good, Inc. <a@good.example>'],
	])('%s is more than one address: %s', async (_, from) => {
		expect(await check(messageFrom(from))).toEqual({
			...refused,
			reason: 'From holds more than one address',
		} as never);
	});

	test.each([
		['a group naming the brand', 'good.example:;'],
		['a group holding the brand', 'Good: a@good.example;'],
		['a group holding the forger', 'Good: x@evil.example;'],
	])('%s is refused: %s', async (_, from) => {
		expect(await check(messageFrom(from))).toEqual({
			...refused,
			reason: 'From holds a group, not a mailbox',
		} as never);
	});

	test('a From hidden behind a bare CR is a second From', async () => {
		const message =
			'From: x@evil.example\r\nX-Note: hi\rFrom: a@good.example\r\n\r\nx';
		expect(await check(message)).toEqual({
			...refused,
			reason: 'the message has more than one From header',
		} as never);
	});

	test('a From behind a bare LF is a second From', async () => {
		const message = 'From: x@evil.example\nFrom: a@good.example\r\n\r\nx';
		expect((await check(message)).reason).toBe(
			'the message has more than one From header',
		);
	});
});

describe('a display name is never the author', () => {
	test.each([
		['a quoted address', '"a@good.example" <x@evil.example>'],
		['a quoted angle address', '"Good <a@good.example>" <x@evil.example>'],
		[
			'an encoded-word address',
			'=?utf-8?q?a=40good.example?= <x@evil.example>',
		],
		['a quoted local part holding an address', '"a@good.example"@evil.example'],
		['a comment holding an address', 'x@evil.example (a@good.example)'],
		['a comment inside the address', 'x(a@good.example)@evil.example'],
	])(
		'%s: the domain is the address its own, evil.example: %s',
		async (_, from) => {
			const got = await check(messageFrom(from));
			expect(got).toMatchObject({
				result: 'pass',
				domain: 'evil.example',
				policyDomain: 'evil.example',
				policy: 'none',
			});
		},
	);
});

describe('fromMailbox reads every honest form', () => {
	test.each([
		['a@example.com', 'example.com'],
		['<a@example.com>', 'example.com'],
		['Ann <a@example.com>', 'example.com'],
		['"Example, Inc." <billing@Example.COM>', 'Example.COM'],
		['John Q. Public <john.q.public@example.com>', 'example.com'],
		['"Joe Q. Public" <john.q.public@example.com>', 'example.com'],
		[
			'Pete(A nice \\) chap) <pete(his account)@silly.test(his host)>',
			'silly.test',
		],
		['"Giant; \\"Big\\" Box" <sysservices@example.net>', 'example.net'],
		['"a b"@example.com', 'example.com'],
		['a . b @ example . com', 'example.com'],
		['a@\r\n example.com', 'example.com'],
		['Ünïcödé <ü@bücher.example>', 'bücher.example'],
		['  a@example.com  ', 'example.com'],
	])('%s', (value, domain) => {
		expect(fromMailbox(value)).toEqual({ domain, literal: false });
	});

	test('a domain literal is read as one, for the caller to refuse', () => {
		expect(fromMailbox('a@[192.0.2.1]')).toEqual({
			domain: '[192.0.2.1]',
			literal: true,
		});
	});
});
