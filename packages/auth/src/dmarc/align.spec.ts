import { describe, expect, test } from 'bun:test';
import { align, isAligned } from './align';
import { dkim, spf } from './dmarc.fixtures';
import { organizationalDomain } from './psl';

const orgOf = (domain: string) => organizationalDomain(domain) ?? domain;

/**
 * RFC 7489 §3.1: strict is an exact match, relaxed is the same
 * organizational domain. Each row is checked for DKIM `d=` and for the
 * SPF domain, in both modes.
 */
const TABLE: readonly (readonly [string, string, boolean, boolean])[] = [
	// authenticated, From, strict, relaxed
	['example.com', 'example.com', true, true],
	['example.com', 'news.example.com', false, true],
	['bounces.example.com', 'example.com', false, true],
	['a.example.com', 'b.example.com', false, true],
	['a.b.example.com', 'c.example.com', false, true],
	['example.net', 'example.com', false, false],
	['example.com.evil.example', 'example.com', false, false],
	['com', 'example.com', false, false],
	['example.com', 'com', false, false],
	['co.uk', 'example.co.uk', false, false],
	['example.co.uk', 'mail.example.co.uk', false, true],
	['other.co.uk', 'example.co.uk', false, false],
	['alice.github.io', 'bob.github.io', false, false],
	['mail.alice.github.io', 'alice.github.io', false, true],
];

describe('isAligned (§3.1.1, §3.1.2)', () => {
	test.each(TABLE)(
		'%s with From %s: strict %p, relaxed %p',
		(auth, from, strict, relaxed) => {
			expect(isAligned(auth, from, 's', orgOf)).toBe(strict);
			expect(isAligned(auth, from, 'r', orgOf)).toBe(relaxed);
		},
	);
});

describe('align: DKIM and SPF × strict and relaxed × subdomain', () => {
	const relaxed = { adkim: 'r', aspf: 'r' } as const;
	const strict = { adkim: 's', aspf: 's' } as const;

	test.each(TABLE)('%s with From %s', (auth, from, isStrict, isRelaxed) => {
		for (const [modes, aligned] of [
			[strict, isStrict],
			[relaxed, isRelaxed],
		] as const) {
			const got = align(from, [dkim(auth)], spf(auth), modes, orgOf);
			expect(got.dkim).toBe(aligned ? auth : undefined);
			expect(got.spf).toBe(aligned ? auth : undefined);
		}
	});

	test('modes apply apart: strict DKIM, relaxed SPF', () => {
		const got = align(
			'example.com',
			[dkim('mail.example.com')],
			spf('bounce.example.com'),
			{ adkim: 's', aspf: 'r' },
			orgOf,
		);
		expect(got).toEqual({ spf: 'bounce.example.com', temporary: false });
	});

	test('only a passing signature aligns; the first aligned one is named', () => {
		const got = align(
			'example.com',
			[
				dkim('example.com', 'fail'),
				dkim('example.net'),
				dkim('mail.example.com'),
				dkim('example.com'),
			],
			undefined,
			{ adkim: 'r', aspf: 'r' },
			orgOf,
		);
		expect(got.dkim).toBe('mail.example.com');
	});

	test('SPF counts only for the MAIL FROM identity, and only on pass', () => {
		const modes = { adkim: 'r', aspf: 'r' } as const;
		expect(
			align(
				'example.com',
				[],
				spf('example.com', 'pass', 'helo'),
				modes,
				orgOf,
			),
		).toEqual({
			temporary: false,
		});
		for (const word of [
			'fail',
			'softfail',
			'neutral',
			'none',
			'permerror',
		] as const) {
			expect(
				align('example.com', [], spf('example.com', word), modes, orgOf).spf,
			).toBeUndefined();
		}
	});

	test('a temporary error counts only on an aligned identifier, and only without a pass', () => {
		const modes = { adkim: 'r', aspf: 'r' } as const;
		const of = (...args: Parameters<typeof align>) => align(...args).temporary;
		expect(
			of(
				'example.com',
				[dkim('example.com', 'temperror')],
				undefined,
				modes,
				orgOf,
			),
		).toBe(true);
		expect(
			of('example.com', [], spf('mail.example.com', 'temperror'), modes, orgOf),
		).toBe(true);
		expect(
			of(
				'example.com',
				[dkim('attacker.example', 'temperror')],
				undefined,
				modes,
				orgOf,
			),
		).toBe(false);
		expect(
			of('example.com', [], spf('attacker.example', 'temperror'), modes, orgOf),
		).toBe(false);
		expect(
			of(
				'example.com',
				[dkim('example.com', 'temperror')],
				spf('example.com'),
				modes,
				orgOf,
			),
		).toBe(false);
	});
});
