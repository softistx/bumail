import { describe, expect, test } from 'bun:test';
import { decodeRules, organizationalDomain } from './psl';
import { PSL_VERSION } from './psl-data';

/**
 * The Public Suffix List's own test vectors (publicsuffix/list,
 * tests/test_psl.txt), every active one: the registrable domain, which is
 * RFC 7489's organizational domain, or `undefined` for a public suffix.
 * Its Unicode names are written here in their A-labels, as
 * `organizationalDomain` answers.
 */
const VECTORS: readonly (readonly [string, string | undefined])[] = [
	['COM', undefined],
	['example.COM', 'example.com'],
	['WwW.example.COM', 'example.com'],
	['.com', undefined],
	['.example', undefined],
	['.example.com', undefined],
	['.example.example', undefined],
	['example', undefined],
	['example.example', 'example.example'],
	['b.example.example', 'example.example'],
	['a.b.example.example', 'example.example'],
	['biz', undefined],
	['domain.biz', 'domain.biz'],
	['b.domain.biz', 'domain.biz'],
	['a.b.domain.biz', 'domain.biz'],
	['com', undefined],
	['example.com', 'example.com'],
	['b.example.com', 'example.com'],
	['a.b.example.com', 'example.com'],
	['uk.com', undefined],
	['example.uk.com', 'example.uk.com'],
	['b.example.uk.com', 'example.uk.com'],
	['a.b.example.uk.com', 'example.uk.com'],
	['test.ac', 'test.ac'],
	['mm', undefined],
	['c.mm', undefined],
	['b.c.mm', 'b.c.mm'],
	['a.b.c.mm', 'b.c.mm'],
	['jp', undefined],
	['test.jp', 'test.jp'],
	['www.test.jp', 'test.jp'],
	['ac.jp', undefined],
	['test.ac.jp', 'test.ac.jp'],
	['www.test.ac.jp', 'test.ac.jp'],
	['kyoto.jp', undefined],
	['test.kyoto.jp', 'test.kyoto.jp'],
	['ide.kyoto.jp', undefined],
	['b.ide.kyoto.jp', 'b.ide.kyoto.jp'],
	['a.b.ide.kyoto.jp', 'b.ide.kyoto.jp'],
	['c.kobe.jp', undefined],
	['b.c.kobe.jp', 'b.c.kobe.jp'],
	['a.b.c.kobe.jp', 'b.c.kobe.jp'],
	['city.kobe.jp', 'city.kobe.jp'],
	['www.city.kobe.jp', 'city.kobe.jp'],
	['ck', undefined],
	['test.ck', undefined],
	['b.test.ck', 'b.test.ck'],
	['a.b.test.ck', 'b.test.ck'],
	['www.ck', 'www.ck'],
	['www.www.ck', 'www.ck'],
	['us', undefined],
	['test.us', 'test.us'],
	['www.test.us', 'test.us'],
	['ak.us', undefined],
	['test.ak.us', 'test.ak.us'],
	['www.test.ak.us', 'test.ak.us'],
	['k12.ak.us', undefined],
	['test.k12.ak.us', 'test.k12.ak.us'],
	['www.test.k12.ak.us', 'test.k12.ak.us'],
	['食狮.com.cn', 'xn--85x722f.com.cn'],
	['食狮.公司.cn', 'xn--85x722f.xn--55qx5d.cn'],
	['www.食狮.公司.cn', 'xn--85x722f.xn--55qx5d.cn'],
	['shishi.公司.cn', 'shishi.xn--55qx5d.cn'],
	['公司.cn', undefined],
	['食狮.中国', 'xn--85x722f.xn--fiqs8s'],
	['www.食狮.中国', 'xn--85x722f.xn--fiqs8s'],
	['shishi.中国', 'shishi.xn--fiqs8s'],
	['中国', undefined],
	['xn--85x722f.com.cn', 'xn--85x722f.com.cn'],
	['xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'],
	['www.xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'],
	['shishi.xn--55qx5d.cn', 'shishi.xn--55qx5d.cn'],
	['xn--55qx5d.cn', undefined],
	['xn--85x722f.xn--fiqs8s', 'xn--85x722f.xn--fiqs8s'],
	['www.xn--85x722f.xn--fiqs8s', 'xn--85x722f.xn--fiqs8s'],
	['shishi.xn--fiqs8s', 'shishi.xn--fiqs8s'],
	['xn--fiqs8s', undefined],
];

describe('organizationalDomain (RFC 7489 §3.2) on the PSL test vectors', () => {
	test.each(VECTORS)('%s → %s', (domain, org) => {
		expect(organizationalDomain(domain)).toBe(org);
	});
});

describe('the embedded list', () => {
	test('has the private section: a tenant of a hosting suffix is its own organization', () => {
		expect(organizationalDomain('alice.github.io')).toBe('alice.github.io');
		expect(organizationalDomain('mail.alice.github.io')).toBe(
			'alice.github.io',
		);
		expect(organizationalDomain('github.io')).toBeUndefined();
	});

	test('the United Kingdom registers companies under co.uk', () => {
		expect(organizationalDomain('mail.example.co.uk')).toBe('example.co.uk');
		expect(organizationalDomain('co.uk')).toBeUndefined();
	});

	test('names its snapshot', () => {
		expect(PSL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}_/);
	});

	test('a name no lookup could take has none', () => {
		expect(organizationalDomain('exa mple.com')).toBeUndefined();
		expect(organizationalDomain('')).toBeUndefined();
		expect(organizationalDomain('[192.0.2.1]')).toBeUndefined();
	});

	test('122 labels are walked only as deep as the rules go', () => {
		const deep = `${'a.'.repeat(120)}kobe.jp`;
		const start = performance.now();
		expect(organizationalDomain(deep)).toBe('a.a.kobe.jp');
		expect(performance.now() - start).toBeLessThan(100);
	});
});

describe('decodeRules', () => {
	test('reads rules, steps, wildcards and exceptions', () => {
		const root = decodeRules('jp?(ac,kobe?(!city,*)),uk?(co)');
		const kobe = root.get('jp')?.kids?.get('kobe');
		expect(root.get('jp')?.rule).toBe(false);
		expect(root.get('jp')?.kids?.get('ac')).toEqual({ rule: true });
		expect(kobe?.rule).toBe(false);
		expect([...(kobe?.kids?.keys() ?? [])]).toEqual(['!city', '*']);
		expect(root.get('uk')?.kids?.get('co')).toEqual({ rule: true });
	});
});
