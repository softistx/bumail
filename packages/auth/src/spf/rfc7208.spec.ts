import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { checkSpf } from './check-spf';
import type { SpfResult } from './result';
import { loadSuite, type SuiteCase } from './rfc7208.fixtures';

/**
 * The OpenSPF RFC 7208 test suite (pyspf's `rfc7208-tests.yml`), every
 * case run against its zone. Where the suite accepts several results, any
 * of them passes. The cases below give another answer, each for the
 * reason written beside it; they are asserted as they are, so a change
 * that makes one pass shows up here.
 */
const EXCEPTIONS: Readonly<
	Record<string, { readonly result: string; readonly why: string }>
> = {
	'a-colon-domain': {
		result: 'neutral',
		why: '@bumail/dns refuses to look up foo:bar/baz.example.com (normalizeName rejects ":" and "/"), so the name matches nothing (and costs no void lookup)',
	},
	'a-colon-domain-ip4mapped': {
		result: 'neutral',
		why: 'the same name as a-colon-domain',
	},
	'mx-colon-domain': {
		result: 'neutral',
		why: 'the same name as a-colon-domain, through MX',
	},
	'mx-colon-domain-ip4mapped': {
		result: 'neutral',
		why: 'the same name as mx-colon-domain',
	},
	'macro-mania-in-domain': {
		result: 'fail',
		why: '@bumail/dns refuses to look up "macro%percent  space%20url-space.example.com" (spaces and "%"), so a:… does not match and -all decides',
	},
	'v-macro-ip6': {
		result: 'fail',
		why: 'the result is right; the suite writes the %{ir} nibbles in uppercase (E.B.A.B.E.F.A.C) as the host was written, where RFC 7208 §7.4 shows them in lowercase, which is what this writes',
	},
};

function agrees(c: SuiteCase, got: SpfResult): boolean {
	if (!c.results.includes(got.result)) return false;
	if (c.explanation === undefined) return true;
	return c.explanation === 'DEFAULT'
		? got.explanation === undefined
		: got.explanation === c.explanation;
}

const suite = await loadSuite();

describe('the RFC 7208 test suite', () => {
	for (const scenario of suite) {
		describe(scenario.description, () => {
			for (const c of scenario.cases) {
				const exception = EXCEPTIONS[c.name];
				test(`${c.name} (§${c.spec})`, async () => {
					const got = await checkSpf(
						{ ip: c.host, mailFrom: c.mailfrom, helo: c.helo },
						{ resolver: fixtureResolver(scenario.zone) },
					);
					if (exception === undefined) {
						expect({ case: c.name, agrees: agrees(c, got), got }).toMatchObject(
							{
								agrees: true,
							},
						);
					} else {
						expect(got.result).toBe(exception.result as SpfResult['result']);
						expect(agrees(c, got)).toBe(false);
					}
				});
			}
		});
	}

	test('runs every case: 203, of which 197 agree and 6 are listed exceptions', async () => {
		const cases = suite.flatMap((scenario) =>
			scenario.cases.map((c) => ({ c, zone: scenario.zone })),
		);
		let agreeing = 0;
		for (const { c, zone } of cases) {
			const got = await checkSpf(
				{ ip: c.host, mailFrom: c.mailfrom, helo: c.helo },
				{ resolver: fixtureResolver(zone) },
			);
			if (agrees(c, got)) agreeing++;
		}
		expect(cases.length).toBe(203);
		expect(agreeing).toBe(cases.length - Object.keys(EXCEPTIONS).length);
	});
});
