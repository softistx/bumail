import { describe, expect, test } from 'bun:test';
import { encodeRules, moduleOf, rulesOf, versionOf } from './refresh-psl';

const LIST = `// This Source Code Form is subject to the terms of the Mozilla Public
// VERSION: 2026-01-02_03-04-05_UTC

// ===BEGIN ICANN DOMAINS===
com
uk
co.uk
*.kawasaki.jp
!city.kawasaki.jp
公司.cn
// ===END ICANN DOMAINS===
// ===BEGIN PRIVATE DOMAINS===
github.io
`;

describe('refresh-psl', () => {
	test('reads the rules, comments and blank lines dropped', () => {
		expect(rulesOf(LIST)).toEqual([
			'com',
			'uk',
			'co.uk',
			'*.kawasaki.jp',
			'!city.kawasaki.jp',
			'公司.cn',
			'github.io',
		]);
	});

	test('encodes a trie of the rules past one label, in A-labels, rightmost first', () => {
		expect(encodeRules(rulesOf(LIST))).toBe(
			'cn?(xn--55qx5d),io?(github),jp?(kawasaki?(!city,*)),uk?(co)',
		);
	});

	test('marks a rule that has rules under it without ?', () => {
		expect(encodeRules(['co.uk', 'a.co.uk'])).toBe('uk?(co(a))');
	});

	test('names the version, and keeps the MPL notice', () => {
		expect(versionOf(LIST)).toBe('2026-01-02_03-04-05_UTC');
		const written = moduleOf(LIST);
		expect(written).toContain('Mozilla Public');
		expect(written).toContain(
			"PSL_VERSION: string = '2026-01-02_03-04-05_UTC'",
		);
	});
});
