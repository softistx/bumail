import { describe, expect, test } from 'bun:test';
import { MimeError } from '../errors';
import {
	checkAddress,
	formatMailbox,
	mailboxesOf,
	parseAddressList,
} from './addresses';

describe('parseAddressList', () => {
	// RFC 5322 Appendix A, its examples.
	test('A.1.1: a name and an address', () => {
		expect(parseAddressList('John Doe <jdoe@machine.example>')).toEqual([
			{ name: 'John Doe', address: 'jdoe@machine.example' },
		]);
	});

	test('A.1.2: quoted names, bare addresses, and specials in a quoted name', () => {
		expect(
			parseAddressList('"Joe Q. Public" <john.q.public@example.com>'),
		).toEqual([
			{ name: 'Joe Q. Public', address: 'john.q.public@example.com' },
		]);
		expect(
			parseAddressList(
				'Mary Smith <mary@x.test>, jdoe@example.org, Who? <one@y.test>',
			),
		).toEqual([
			{ name: 'Mary Smith', address: 'mary@x.test' },
			{ name: '', address: 'jdoe@example.org' },
			{ name: 'Who?', address: 'one@y.test' },
		]);
		expect(
			parseAddressList(
				'<boss@nil.test>, "Giant; \\"Big\\" Box" <sysservices@example.net>',
			),
		).toEqual([
			{ name: '', address: 'boss@nil.test' },
			{ name: 'Giant; "Big" Box', address: 'sysservices@example.net' },
		]);
	});

	test('A.1.3: groups, one of them empty', () => {
		expect(
			parseAddressList(
				'A Group:Ed Jones <c@a.test>,joe@where.test,John <jdoe@one.test>;',
			),
		).toEqual([
			{
				group: 'A Group',
				members: [
					{ name: 'Ed Jones', address: 'c@a.test' },
					{ name: '', address: 'joe@where.test' },
					{ name: 'John', address: 'jdoe@one.test' },
				],
			},
		]);
		expect(parseAddressList('Undisclosed recipients:;')).toEqual([
			{ group: 'Undisclosed recipients', members: [] },
		]);
	});

	test('A.5: white space and comments everywhere', () => {
		expect(
			parseAddressList(
				'Pete(A nice \\) chap) <pete(his account)@silly.test(his host)>',
			),
		).toEqual([{ name: 'Pete', address: 'pete@silly.test' }]);
		expect(
			parseAddressList(
				"A Group(Some people)\r\n     :Chris Jones <c@(Chris's host.)public.example>,\r\n         joe@example.org,\r\n  John <jdoe@one.test> (my dear friend); (the end of the group)",
			),
		).toEqual([
			{
				group: 'A Group',
				members: [
					{ name: 'Chris Jones', address: 'c@public.example' },
					{ name: '', address: 'joe@example.org' },
					{ name: 'John', address: 'jdoe@one.test' },
				],
			},
		]);
		expect(
			parseAddressList(
				'(Empty list)(start)Hidden recipients  :(nobody(that I know))  ;',
			),
		).toEqual([{ group: 'Hidden recipients', members: [] }]);
	});

	test('A.6.1 and §4.4: obsolete routes and white space around dots', () => {
		expect(
			parseAddressList(
				'Mary Smith <@node.test:mary@example.net>, , jdoe@test  . example',
			),
		).toEqual([
			{ name: 'Mary Smith', address: 'mary@example.net' },
			{ name: '', address: 'jdoe@test.example' },
		]);
		expect(
			parseAddressList('John Doe <jdoe@machine(comment).  example>'),
		).toEqual([{ name: 'John Doe', address: 'jdoe@machine.example' }]);
	});

	test('the name in a comment, the old way', () => {
		expect(
			parseAddressList('nsb@thumper.bellcore.com (Nathaniel Borenstein)'),
		).toEqual([
			{ name: 'Nathaniel Borenstein', address: 'nsb@thumper.bellcore.com' },
		]);
	});

	test('RFC 2047 §8: encoded-words in display names', () => {
		expect(
			parseAddressList(
				'=?US-ASCII?Q?Keith_Moore?= <moore@cs.utk.edu>, =?ISO-8859-1?Q?Andr=E9?= Pirard <PIRARD@vm1.ulg.ac.be>',
			),
		).toEqual([
			{ name: 'Keith Moore', address: 'moore@cs.utk.edu' },
			{ name: 'André Pirard', address: 'PIRARD@vm1.ulg.ac.be' },
		]);
	});

	test('a quoted local part keeps its quotes', () => {
		expect(parseAddressList('"john doe"@example.com')).toEqual([
			{ name: '', address: '"john doe"@example.com' },
		]);
	});

	test('a domain literal', () => {
		expect(parseAddressList('<postmaster@[192.0.2.1]>')).toEqual([
			{ name: '', address: 'postmaster@[192.0.2.1]' },
		]);
	});

	test('RFC 6532: UTF-8 addresses', () => {
		expect(parseAddressList('Jörg <jörg@bücher.example>')).toEqual([
			{ name: 'Jörg', address: 'jörg@bücher.example' },
		]);
	});

	test('mailboxesOf opens the groups', () => {
		expect(
			mailboxesOf(parseAddressList('a@x.test, G: b@x.test, c@x.test;')).map(
				(m) => m.address,
			),
		).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
	});

	test('nothing readable gives an empty list, never an error', () => {
		expect(parseAddressList('')).toEqual([]);
		expect(parseAddressList(',,,')).toEqual([]);
	});
});

describe('formatMailbox', () => {
	test('a bare address', () => {
		expect(formatMailbox('jdoe@example.org')).toBe('jdoe@example.org');
	});

	test('a plain name is written as is, a name with specials is quoted', () => {
		expect(
			formatMailbox({ name: 'John Doe', address: 'jdoe@example.org' }),
		).toBe('John Doe <jdoe@example.org>');
		expect(
			formatMailbox({ name: 'Doe, John "JD"', address: 'jdoe@example.org' }),
		).toBe('"Doe, John \\"JD\\"" <jdoe@example.org>');
	});

	test('a name that is not ASCII is encoded whole, specials and all', () => {
		const written = formatMailbox({
			name: 'Doe, Jöhn <x@y.z>',
			address: 'j@example.org',
		});
		expect(written).toMatch(/^=\?UTF-8\?B\?[^ ]+\?= <j@example\.org>$/);
		expect(parseAddressList(written)).toEqual([
			{ name: 'Doe, Jöhn <x@y.z>', address: 'j@example.org' },
		]);
	});

	test('a name that is not ASCII is encoded, and parses back', () => {
		const written = formatMailbox({
			name: 'André Pirard',
			address: 'andre@example.org',
		});
		expect(/^[\x20-\x7e]*$/.test(written)).toBe(true);
		expect(parseAddressList(written)).toEqual([
			{ name: 'André Pirard', address: 'andre@example.org' },
		]);
	});

	test('a line break or a missing @ is refused', () => {
		expect(() => formatMailbox('a@b.test\r\nBcc: x@y.test')).toThrow(MimeError);
		expect(() => formatMailbox('nobody')).toThrow('is not an e-mail address');
		expect(() =>
			formatMailbox({ name: 'x\r\ny', address: 'a@b.test' }),
		).toThrow('cannot hold a line break');
	});
});

describe('checkAddress', () => {
	test('dot-atoms, quoted local parts, non-ASCII (RFC 6532) and address literals pass', () => {
		for (const address of [
			'jdoe@example.org',
			'jo.e+tag@sub.example.org',
			'"john doe"@example.org',
			'"a\\"b"@example.org',
			'José@exämple.fr',
			'u@[192.0.2.1]',
			'u@[IPv6:2001:db8::1]',
			'u@[x-tag:some-content]',
		]) {
			expect(checkAddress(address, 't()')).toBe(address);
		}
	});

	test('a comma, semicolon, comment, stray quote, space or empty label is refused', () => {
		for (const address of [
			'a@b.test,victim@evil.test',
			'a;b:c@d.test',
			'a(@b.test',
			'"@x.test',
			'a b@c.test',
			'a@b c',
			'a..b@c.test',
			'.a@b.test',
			'a@-b.test',
			'a@b..test',
			'a@b.test\r\nRCPT TO:<x@y.test>',
			'a@',
			'@b.test',
		]) {
			expect(() => checkAddress(address, 'mine()')).toThrow('mine(): ');
		}
	});

	test('an address literal is IPv4, IPv6: or tag:content (RFC 5321 §4.1.3), with no <, >, , or "', () => {
		for (const address of [
			'a@[x>]',
			'a@[192.0.2.1>]',
			'a@[tag:a>b]',
			'a@[tag:a<b]',
			'a@[tag:a,b]',
			'a@[tag:a"b]',
			'a@[999.0.2.1]',
			'a@[nocolon]',
			'a@[]',
		]) {
			expect(() => checkAddress(address, 'mine()')).toThrow('mine(): ');
		}
	});

	test('characters that hide or reorder text are refused: C1, zero-width, separators, bidi', () => {
		for (const char of [
			'\u0085',
			'\u009b',
			'\u200b',
			'\u200f',
			'\u2028',
			'\u2029',
			'\u202e',
			'\u2066',
			'\u2069',
			'\u00ad',
			'\u061c',
			'\u180e',
			'\u2060',
			'\u2064',
			'\ufeff',
		]) {
			expect(() => checkAddress(`a@b${char}.test`, 'mine()')).toThrow(
				'mine(): ',
			);
			expect(() => checkAddress(`a${char}@b.test`, 'mine()')).toThrow(
				'mine(): ',
			);
		}
	});

	test('an astral format character is escaped whole', () => {
		expect(() => checkAddress('a\u{e0001}@b.test', 'mine()')).toThrow(
			'mine(): "a\\u{e0001}@b.test" is not an e-mail address',
		);
	});

	test('the error shows an invisible character as an escape, so the address does not look valid', () => {
		expect(() => checkAddress('a\u200b@b.test', 'mine()')).toThrow(
			'mine(): "a\\u200b@b.test" is not an e-mail address',
		);
	});
});
