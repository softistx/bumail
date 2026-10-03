import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { checkSpf } from './check-spf';
import { expand } from './expand';
import { parseMacroString } from './macro';
import { appendixA, runOf } from './spf.fixtures';

async function expanded(ip: string, text: string): Promise<string | undefined> {
	const parsed = parseMacroString(text, 'domain');
	if (typeof parsed === 'string') throw new Error(parsed);
	const run = runOf(ip, 'strong-bad@email.example.com', fixtureResolver({}));
	return expand(run, parsed.parts, 'email.example.com');
}

describe('RFC 7208 §7.4: expansion examples', () => {
	test.each([
		['%{s}', 'strong-bad@email.example.com'],
		['%{o}', 'email.example.com'],
		['%{d}', 'email.example.com'],
		['%{d4}', 'email.example.com'],
		['%{d3}', 'email.example.com'],
		['%{d2}', 'example.com'],
		['%{d1}', 'com'],
		['%{dr}', 'com.example.email'],
		['%{d2r}', 'example.email'],
		['%{l}', 'strong-bad'],
		['%{l-}', 'strong.bad'],
		['%{lr}', 'strong-bad'],
		['%{lr-}', 'bad.strong'],
		['%{l1r-}', 'strong'],
		['%{ir}.%{v}._spf.%{d2}', '3.2.0.192.in-addr._spf.example.com'],
		['%{lr-}.lp._spf.%{d2}', 'bad.strong.lp._spf.example.com'],
		[
			'%{lr-}.lp.%{ir}.%{v}._spf.%{d2}',
			'bad.strong.lp.3.2.0.192.in-addr._spf.example.com',
		],
		[
			'%{ir}.%{v}.%{l1r-}.lp._spf.%{d2}',
			'3.2.0.192.in-addr.strong.lp._spf.example.com',
		],
		[
			'%{d2}.trusted-domains.example.net',
			'example.com.trusted-domains.example.net',
		],
	])('%s', async (macro, expansion) => {
		expect(await expanded('192.0.2.3', macro)).toBe(expansion);
	});

	test('IPv6: %{ir}.%{v}._spf.%{d2}', async () => {
		expect(await expanded('2001:db8::cb01', '%{ir}.%{v}._spf.%{d2}')).toBe(
			'1.0.b.c.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6._spf.example.com',
		);
	});
});

async function passes(record: string, ip: string): Promise<string> {
	const resolver = fixtureResolver(appendixA(record));
	const got = await checkSpf(
		{ ip, mailFrom: 'joe@example.com', helo: 'mx.example.net' },
		{ resolver },
	);
	return got.result;
}

describe('RFC 7208 Appendix A.1: simple examples', () => {
	test('v=spf1 +all: any <ip> passes', async () => {
		expect(await passes('v=spf1 +all', '198.51.100.7')).toBe('pass');
		expect(await passes('v=spf1 +all', '2001:db8::1')).toBe('pass');
	});

	test('v=spf1 a -all: hosts 192.0.2.10 and 192.0.2.11 pass', async () => {
		expect(await passes('v=spf1 a -all', '192.0.2.10')).toBe('pass');
		expect(await passes('v=spf1 a -all', '192.0.2.11')).toBe('pass');
		expect(await passes('v=spf1 a -all', '192.0.2.12')).toBe('fail');
	});

	test('v=spf1 a:example.org -all: no sending hosts pass', async () => {
		expect(await passes('v=spf1 a:example.org -all', '192.0.2.140')).toBe(
			'fail',
		);
	});

	test('v=spf1 mx -all: 192.0.2.129 and 192.0.2.130 pass', async () => {
		expect(await passes('v=spf1 mx -all', '192.0.2.129')).toBe('pass');
		expect(await passes('v=spf1 mx -all', '192.0.2.130')).toBe('pass');
		expect(await passes('v=spf1 mx -all', '192.0.2.140')).toBe('fail');
	});

	test('v=spf1 mx:example.org -all: 192.0.2.140 passes', async () => {
		expect(await passes('v=spf1 mx:example.org -all', '192.0.2.140')).toBe(
			'pass',
		);
		expect(await passes('v=spf1 mx:example.org -all', '192.0.2.129')).toBe(
			'fail',
		);
	});

	test('v=spf1 mx mx:example.org -all: 129, 130 and 140 pass', async () => {
		for (const ip of ['192.0.2.129', '192.0.2.130', '192.0.2.140']) {
			expect(await passes('v=spf1 mx mx:example.org -all', ip)).toBe('pass');
		}
	});

	test('v=spf1 mx/30 mx:example.org/30 -all: 192.0.2.128/30 and 192.0.2.140/30 pass', async () => {
		const record = 'v=spf1 mx/30 mx:example.org/30 -all';
		for (const ip of [
			'192.0.2.128',
			'192.0.2.131',
			'192.0.2.141',
			'192.0.2.143',
		]) {
			expect(await passes(record, ip)).toBe('pass');
		}
		expect(await passes(record, '192.0.2.132')).toBe('fail');
	});

	test('v=spf1 ptr -all: 65 passes, 140 fails (not in example.com), 10.0.0.4 fails (not valid)', async () => {
		expect(await passes('v=spf1 ptr -all', '192.0.2.65')).toBe('pass');
		expect(await passes('v=spf1 ptr -all', '192.0.2.140')).toBe('fail');
		expect(await passes('v=spf1 ptr -all', '10.0.0.4')).toBe('fail');
	});

	test('v=spf1 ip4:192.0.2.128/28 -all: 65 fails, 129 passes', async () => {
		expect(await passes('v=spf1 ip4:192.0.2.128/28 -all', '192.0.2.65')).toBe(
			'fail',
		);
		expect(await passes('v=spf1 ip4:192.0.2.128/28 -all', '192.0.2.129')).toBe(
			'pass',
		);
	});
});

describe('RFC 7208 Appendix A.2 to A.4', () => {
	const mobile = {
		'mobile-users._spf.example.com': { txt: ['v=spf1 exists:%{l1r+}.%{d}'] },
		'remote-users._spf.example.com': {
			txt: ['v=spf1 exists:%{ir}.%{l1r+}.%{d}'],
		},
		'mary.mobile-users._spf.example.com': { a: ['127.0.0.2'] },
		'15.15.168.192.joel.remote-users._spf.example.com': { a: ['127.0.0.2'] },
		'example.org': { txt: ['v=spf1 include:example.com -all'] },
		'la.example.org': { txt: ['v=spf1 redirect=example.org'] },
	};
	const record =
		'v=spf1 mx include:mobile-users._spf.%{d} include:remote-users._spf.%{d} -all';

	async function check(ip: string, mailFrom: string): Promise<string> {
		const resolver = fixtureResolver(appendixA(record, mobile));
		return (
			await checkSpf({ ip, mailFrom, helo: 'h.example.net' }, { resolver })
		).result;
	}

	test('A.3: mary passes from anywhere, joel from his servers, others fail', async () => {
		expect(await check('198.51.100.9', 'mary@example.com')).toBe('pass');
		expect(await check('192.168.15.15', 'joel@example.com')).toBe('pass');
		expect(await check('192.168.15.16', 'joel@example.com')).toBe('fail');
		expect(await check('198.51.100.9', 'fred@example.com')).toBe('fail');
	});

	test("A.2: a redirect and an include share example.com's servers", async () => {
		expect(await check('192.0.2.129', 'a@la.example.org')).toBe('pass');
		expect(await check('198.51.100.9', 'a@la.example.org')).toBe('fail');
	});

	test('A.4, as printed: ptr in ptr._spf.%{d} defaults to that domain, so every host fails', async () => {
		const zone = appendixA(
			'v=spf1 -include:ip4._spf.%{d} -include:ptr._spf.%{d} +all',
			{
				'ip4._spf.example.com': { txt: ['v=spf1 -ip4:192.0.2.0/24 +all'] },
				'ptr._spf.example.com': { txt: ['v=spf1 -ptr +all'] },
			},
		);
		const at = async (ip: string) =>
			(
				await checkSpf(
					{ ip, mailFrom: 'joe@example.com', helo: 'h.example.net' },
					{ resolver: fixtureResolver(zone) },
				)
			).result;
		expect(await at('192.0.2.65')).toBe('fail');
		expect(await at('10.0.0.4')).toBe('fail');
	});
});
