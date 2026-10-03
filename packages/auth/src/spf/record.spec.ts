import { describe, expect, test } from 'bun:test';
import { parseMacroString } from './macro';
import { isSpfRecord, parseRecord, type SpfRecord } from './record';

function parsed(text: string): SpfRecord {
	const record = parseRecord(text);
	if (typeof record === 'string') throw new Error(record);
	return record;
}

describe('record selection (RFC 7208 §4.5)', () => {
	test('v=spf1, any case, then a space or the end', () => {
		expect(isSpfRecord('v=spf1')).toBe(true);
		expect(isSpfRecord('V=SpF1 -all')).toBe(true);
		expect(isSpfRecord('v=spf10')).toBe(false);
		expect(isSpfRecord('v=spf1mx')).toBe(false);
		expect(isSpfRecord(' v=spf1')).toBe(false);
		expect(isSpfRecord('v=DMARC1; p=none')).toBe(false);
	});
});

describe('parseRecord (§4.6, §5, §6)', () => {
	test('reads qualifiers, dual CIDR lengths and modifiers', () => {
		const record = parsed(
			'v=spf1 a/24//64 -mx:example.org//48 ~ip4:192.0.2.0/24 ?ip6:2001:db8::/32 ptr exists:%{i}.x.example redirect=_spf.example.com exp=why.example.com',
		);
		expect(record.mechanisms.map((m) => [m.qualifier, m.kind])).toEqual([
			['+', 'a'],
			['-', 'mx'],
			['~', 'ip4'],
			['?', 'ip6'],
			['+', 'ptr'],
			['+', 'exists'],
		]);
		expect(record.mechanisms[0]).toMatchObject({ cidr4: 24, cidr6: 64 });
		expect(record.mechanisms[1]).toMatchObject({ cidr4: 32, cidr6: 48 });
		expect(record.mechanisms[2]).toMatchObject({ prefix: 24 });
		expect(record.redirect).toEqual(['_spf.example.com']);
		expect(record.exp).toEqual(['why.example.com']);
	});

	test('takes several spaces and a trailing one, and ignores unknown modifiers', () => {
		const record = parsed('v=spf1  a   moo.cow-far_out=man:dog/cat -all ');
		expect(record.mechanisms.map((m) => m.text)).toEqual(['a', '-all']);
	});

	test('mechanism and modifier names are case-insensitive', () => {
		expect(parsed('v=spf1 A MX -ALL Redirect=x.example.com').redirect).toEqual([
			'x.example.com',
		]);
	});

	test.each([
		['v=spf1 -all.', 'malformed -all.'],
		['v=spf1 all:foo', 'malformed all:foo'],
		['v=spf1 moo', 'unknown mechanism moo'],
		[
			'v=spf1 redirect:x.example.com',
			'unknown mechanism redirect:x.example.com',
		],
		['v=spf1 =all', 'unknown mechanism =all'],
		['v=spf1 ip4', 'ip4 has no network in ip4'],
		['v=spf1 ip4:1.2.3', 'bad ip4 network in ip4:1.2.3'],
		['v=spf1 ip4:1.2.3.4:25', 'bad ip4 network in ip4:1.2.3.4:25'],
		['v=spf1 ip4:1.2.3.4/33', 'bad CIDR length in ip4:1.2.3.4/33'],
		['v=spf1 ip4:1.2.3.4/032', 'bad CIDR length in ip4:1.2.3.4/032'],
		['v=spf1 ip4:1.2.3.4//32', 'bad ip4 network in ip4:1.2.3.4//32'],
		['v=spf1 ip6::CAFE::BABE', 'bad ip6 network in ip6::CAFE::BABE'],
		['v=spf1 ip6:::1/129', 'bad CIDR length in ip6:::1/129'],
		['v=spf1 a/24/64', 'bad CIDR length in a/24/64'],
		['v=spf1 a//129', 'bad CIDR length in a//129'],
		['v=spf1 ptr/0', 'unknown mechanism ptr/0'],
		['v=spf1 a:', 'an empty domain-spec'],
		['v=spf1 include', 'unknown mechanism include'],
		['v=spf1 a:museum', '"museum" is not a domain-spec'],
		['v=spf1 a:abc.123', '"abc.123" is not a domain-spec'],
		['v=spf1 a:example.-com', '"example.-com" is not a domain-spec'],
		[
			'v=spf1 include:x.example.com/24',
			'"x.example.com/24" is not a domain-spec',
		],
		['v=spf1 exp=a.example exp=b.example', 'exp= appears twice'],
		['v=spf1 redirect=', 'redirect=: an empty domain-spec'],
		['v=spf1 -all foo=%abc', 'a "%" that starts no macro in "%abc"'],
		['v=spf1 exp=%{r}.example.com', 'exp=: unknown macro %{r}'],
		['v=spf1 a:%{d0}.example.com', 'macro %{d0} keeps zero parts'],
		['v=spf1 a:%{dx}.example.com', 'malformed macro %{dx}'],
		[
			'v=spf1 a:ctrl.example.com\rptr',
			'character "\\r" in "ctrl.example.com\\rptr"',
		],
	])('%p is refused: %s', (text, error) => {
		expect(parseRecord(text)).toBe(error);
	});

	test('a domain-spec may end in a macro, or a top label with a hyphen, and hold any visible character', () => {
		expect(
			parseRecord(
				'v=spf1 a:%{d} a:foo.xn--zckzah a:foo:bar/baz.example.com a:x.example.com.',
			),
		).not.toBeTypeOf('string');
	});
});

describe('parseMacroString (§7.1)', () => {
	test('reads the escapes', () => {
		const got = parseMacroString('a%%b%_c%-d', 'domain');
		expect(got).toEqual({ parts: ['a%b c%20d'], endsWithMacro: false });
	});

	test('allows c, r and t, and spaces, in an explanation only', () => {
		expect(parseMacroString('%{c} %{r} %{t}', 'explanation')).not.toBeTypeOf(
			'string',
		);
		expect(parseMacroString('%{c}', 'domain')).toBe('unknown macro %{c}');
		expect(parseMacroString('a b', 'domain')).toBe('character " " in "a b"');
	});

	test('reads a count, r and several delimiters', () => {
		expect(parseMacroString('%{L2r+-}', 'domain')).toEqual({
			parts: [
				{ letter: 'l', escape: true, keep: 2, reverse: true, delimiters: '+-' },
			],
			endsWithMacro: true,
		});
	});
});
