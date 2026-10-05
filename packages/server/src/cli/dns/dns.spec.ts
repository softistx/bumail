import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FixtureRecords, fixtureResolver } from '@bumail/dns';
import { ACME, tempDir } from '../../config/config.fixtures';
import { Directory } from '../../directory/directory';
import { run } from '../run';
import { issuer } from './plan';

interface Ran {
	code: number;
	out: string;
	err: string;
}

/** A server with `example.com` (DKIM key, a postmaster) and `example.org` (neither), and `bumail` run in this process. */
async function server(extra = '') {
	const data = tempDir();
	const config = join(data, 'bumail.toml');
	writeFileSync(
		config,
		`hostname = "mail.example.com"\ndata = "${data}"\n${extra}${ACME}`,
	);
	const directory = Directory.open({ file: join(data, 'directory.sqlite') });
	directory.domains.add('example.com');
	directory.domains.add('example.org');
	await directory.users.add('postmaster@example.com', 'correct horse battery');
	const key = await directory.dkim.generate('example.com');
	directory.close();
	return {
		key,
		data,
		async bumail(
			args: readonly string[],
			records: FixtureRecords = {},
		): Promise<Ran> {
			let out = '';
			let err = '';
			const code = await run(['--config', config, ...args], {
				out: (text) => {
					out += text;
				},
				err: (text) => {
					err += text;
				},
				env: {},
				version: '0.0.0',
				terminal: {
					stdin: async () => '',
					isTTY: false,
					prompt: async () => '',
				},
				resolver: fixtureResolver(records),
			});
			return { code, out, err };
		},
	};
}

describe('bumail dns', () => {
	test('prints the records of every hosted domain as a zone file', async () => {
		const { bumail, key } = await server();
		const { code, out, err } = await bumail(['dns', '--ip', '192.0.2.10']);
		expect(err).toBe('');
		expect(code).toBe(0);
		const dkimLines = out.split('\n').filter((l) => l.includes('._domainkey.'));
		expect(dkimLines).toHaveLength(1);
		expect(out.replace(dkimLines[0] ?? '', '<dkim>')).toBe(
			[
				'; DNS records for mail.example.com, and the domains it hosts.',
				'; Publish them at your DNS host, then run bumail dns --check.',
				'',
				'; mail.example.com (this server)',
				'mail.example.com. IN A 192.0.2.10',
				'; optional: mail.example.com. IN CAA 0 issue "letsencrypt.org"',
				'; optional: if the server has a public IPv6 address, bumail dns --ip6 <address> writes its AAAA record',
				'; the reverse DNS (PTR) of 192.0.2.10 should be mail.example.com: it is set at your hosting provider, and many receivers refuse mail without it',
				'; the SRV records carry the ports the server listens on: behind Docker port mapping or a proxy, write the public ports instead',
				'',
				'; example.com',
				'example.com. IN MX 10 mail.example.com.',
				'example.com. IN TXT "v=spf1 mx -all"',
				'<dkim>',
				'_dmarc.example.com. IN TXT "v=DMARC1; p=quarantine; adkim=s; rua=mailto:postmaster@example.com"',
				'_submissions._tcp.example.com. IN SRV 0 1 465 mail.example.com.',
				'_imaps._tcp.example.com. IN SRV 0 1 993 mail.example.com.',
				'_jmap._tcp.example.com. IN SRV 0 1 443 mail.example.com.',
				'',
				'; example.org',
				'example.org. IN MX 10 mail.example.com.',
				'example.org. IN TXT "v=spf1 mx -all"',
				'_dmarc.example.org. IN TXT "v=DMARC1; p=none; adkim=s"',
				'_submissions._tcp.example.org. IN SRV 0 1 465 mail.example.com.',
				'_imaps._tcp.example.org. IN SRV 0 1 993 mail.example.com.',
				'_jmap._tcp.example.org. IN SRV 0 1 443 mail.example.com.',
				'; no DKIM key yet: bumail dkim generate example.org makes one, and bumail dns prints its record; until then DMARC is p=none, so nothing is quarantined for lack of a signature',
				'',
			].join('\n'),
		);
		expect(dkimLines[0]).toStartWith(
			'bumail._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjAN',
		);
		expect(key.record).toStartWith('v=DKIM1; k=rsa; p=');
	});

	test('without --ip it reminds, in a comment, and writes no A record', async () => {
		const { bumail } = await server();
		const { code, out } = await bumail(['dns', 'example.org']);
		expect(code).toBe(0);
		expect(out).toContain(
			"; its A record is the server's public IPv4 address, which the server cannot know: run bumail dns --ip <address>",
		);
		expect(out).not.toMatch(/^mail\.example\.com\. IN A /m);
		expect(out).not.toContain('example.com. IN MX');
	});

	test('--ip6 writes the AAAA record, and a named domain only its own', async () => {
		const { bumail } = await server();
		const { out } = await bumail([
			'dns',
			'Example.COM',
			'--ip6',
			'2001:db8::10',
		]);
		expect(out).toContain('mail.example.com. IN AAAA 2001:db8::10');
		expect(out).toContain(
			'the reverse DNS (PTR) of 2001:db8::10 should be mail.example.com',
		);
		expect(out).not.toContain('example.org');
		expect(out).not.toContain('optional: if the server has a public IPv6');
	});

	test('a smarthost adds a note to the SPF record', async () => {
		const { bumail } = await server(
			'[smarthost]\nhost = "relay.example.net"\n',
		);
		const { out } = await bumail(['dns', 'example.org']);
		expect(out).toContain(
			'; outbound mail goes through the smarthost relay.example.net: add its SPF include to the SPF record above, as its provider says',
		);
	});

	test('a port that is off has no SRV record', async () => {
		const off = await server('[ports]\nsubmissions = 0\nhttps = 0\n');
		const { out } = await off.bumail(['dns', 'example.org']);
		expect(out).toContain('_imaps._tcp.example.org.');
		expect(out).not.toContain('_submissions');
		expect(out).not.toContain('_jmap._tcp.example.org.');
	});

	test('an IP address as jmap.origin has no JMAP SRV record, and says so', async () => {
		const { bumail } = await server('[jmap]\norigin = "https://192.0.2.7"\n');
		const { code, out, err } = await bumail(['dns', 'example.org']);
		expect(err).toBe('');
		expect(code).toBe(0);
		expect(out).not.toContain('_jmap._tcp.example.org.');
		expect(out).toContain(
			'; no _jmap._tcp record: jmap.origin names an IP address',
		);
	});

	test('behind a proxy, the JMAP SRV points to the public origin', async () => {
		const { bumail } = await server(
			'[ports]\nhttps = 8081\n[jmap]\nmode = "proxy"\norigin = "https://jmap.example.com:8443"\ntrusted = ["10.0.0.0/8"]\n',
		);
		const { out, err } = await bumail(['dns', 'example.org']);
		expect(err).toBe('');
		expect(out).toContain(
			'_jmap._tcp.example.org. IN SRV 0 1 8443 jmap.example.com.',
		);
	});
});

describe('the CA of a CAA line', () => {
	test("is Let's Encrypt for its own hosts only, on a dot boundary", () => {
		expect(issuer('https://acme-v02.api.letsencrypt.org/directory')).toBe(
			'letsencrypt.org',
		);
		expect(
			issuer('https://acme-staging-v02.api.letsencrypt.org/directory'),
		).toBe('letsencrypt.org');
		expect(issuer('https://letsencrypt.org/directory')).toBe('letsencrypt.org');
		expect(issuer('https://acme.notletsencrypt.org/directory')).toBeUndefined();
		expect(issuer('https://acme.example.net/directory')).toBeUndefined();
	});
});

describe('bumail dns --json', () => {
	test('prints records and notes as JSON', async () => {
		const { bumail, key } = await server();
		const { code, out } = await bumail(['dns', 'example.com', '--json']);
		expect(code).toBe(0);
		const json = JSON.parse(out);
		expect(json.hostname).toBe('mail.example.com');
		expect(json.domains).toEqual(['example.com']);
		expect(json.records.map((r: { purpose: string }) => r.purpose)).toEqual([
			'caa',
			'mx',
			'spf',
			'dkim',
			'dmarc',
			'srv',
			'srv',
			'srv',
		]);
		expect(json.records[1]).toEqual({
			scope: 'example.com',
			purpose: 'mx',
			optional: false,
			name: 'example.com',
			type: 'MX',
			priority: 10,
			value: 'mail.example.com',
		});
		expect(json.records[0]).toMatchObject({ optional: true, type: 'CAA' });
		expect(json.records[3]).toMatchObject({
			name: key.name,
			type: 'TXT',
			value: key.record,
		});
		expect(json.notes).toHaveLength(3);
		expect(json.checks).toBeUndefined();
	});
});

/** The DNS of a deployment that did everything `bumail dns --ip 192.0.2.10 example.com` says. */
function published(key: { name: string; record: string }): FixtureRecords {
	return {
		'mail.example.com': { a: ['192.0.2.10'] },
		'192.0.2.10': { ptr: ['mail.example.com'] },
		'example.com': {
			mx: [{ exchange: 'mail.example.com', priority: 10 }],
			txt: ['v=spf1 mx -all'],
		},
		[key.name]: { txt: [key.record] },
		'_dmarc.example.com': {
			txt: [
				'v=DMARC1; p=quarantine; adkim=s; rua=mailto:postmaster@example.com',
			],
		},
	};
}

const CHECK = ['dns', 'example.com', '--check', '--ip', '192.0.2.10'];

describe('bumail dns --check', () => {
	test('exits 0 when every record is there', async () => {
		const { bumail, key } = await server();
		const { code, out, err } = await bumail(CHECK, published(key));
		expect(err).toBe('');
		expect(out).toBe(
			[
				'mail.example.com',
				'  ok          A    mail.example.com  192.0.2.10',
				'  ok          PTR  192.0.2.10  mail.example.com',
				'example.com',
				'  ok          MX   example.com  10 mail.example.com',
				'  ok          TXT  example.com  v=spf1 mx -all',
				`  ok          TXT  ${key.name}  ${key.record.slice(0, 72)}…`,
				'  ok          TXT  _dmarc.example.com  v=DMARC1; p=quarantine; adkim=s; rua=mailto:postmaster@example.com',
				'  unchecked   SRV  _submissions._tcp.example.com  1 465 mail.example.com',
				'  unchecked   SRV  _imaps._tcp.example.com  1 993 mail.example.com',
				'  unchecked   SRV  _jmap._tcp.example.com  1 443 mail.example.com',
				'',
				'all 6 records checked are in the DNS; 3 (SRV) cannot be looked up here',
				'',
			].join('\n'),
		);
		expect(code).toBe(0);
	});

	test('exits 1 and says what is missing, what differs, what is doubled and what did not answer', async () => {
		const { bumail, key } = await server();
		const { code, out } = await bumail(CHECK, {
			...published(key),
			'mail.example.com': { a: ['192.0.2.99'] },
			'192.0.2.10': { error: 'TIMEOUT' },
			'example.com': {
				mx: [{ exchange: 'other.example.net', priority: 10 }],
				txt: ['v=spf1 a -all', 'v=spf1 mx -all', 'google-site-verification=x'],
			},
			'_dmarc.example.com': { txt: ['v=DMARC1; p=none'] },
			[key.name]: {},
		});
		expect(code).toBe(1);
		expect(out).toContain('  differs     A    mail.example.com  192.0.2.10\n');
		expect(out).toContain('                   found  192.0.2.99\n');
		expect(out).toContain('  unavailable PTR  192.0.2.10  mail.example.com\n');
		expect(out).toContain(
			'                   The fixture answers PTR 192.0.2.10 with TIMEOUT\n',
		);
		expect(out).toContain(
			'  differs     MX   example.com  10 mail.example.com\n',
		);
		expect(out).toContain('                   found  10 other.example.net\n');
		expect(out).toContain('  duplicate   TXT  example.com  v=spf1 mx -all\n');
		expect(out).toContain(
			'                   found  v=spf1 a -all\n                   found  v=spf1 mx -all\n',
		);
		expect(out).not.toContain('google-site-verification');
		expect(out).toContain(`  missing     TXT  ${key.name}  v=DKIM1;`);
		expect(out).toContain('                   found  v=DMARC1; p=none\n');
		expect(out).toEndWith(
			'1 missing, 3 differs, 1 duplicate, 1 unavailable: bumail dns prints what to publish\n',
		);
	});

	test('two DMARC records are a duplicate, even when one is right', async () => {
		const { bumail, key } = await server();
		const records = published(key);
		const { code, out } = await bumail(CHECK, {
			...records,
			'_dmarc.example.com': {
				txt: [
					'v=DMARC1; p=quarantine; adkim=s; rua=mailto:postmaster@example.com',
					'v=DMARC1; p=none',
				],
			},
		});
		expect(code).toBe(1);
		expect(out).toContain('  duplicate   TXT  _dmarc.example.com');
	});

	test('two DKIM records at the selector are a duplicate: a verifier takes the first', async () => {
		const { bumail, key } = await server();
		const { code, out } = await bumail(CHECK, {
			...published(key),
			[key.name]: { txt: ['v=DKIM1; p=', key.record] },
		});
		expect(code).toBe(1);
		expect(out).toContain(`  duplicate   TXT  ${key.name}`);
		expect(out).toContain('found  v=DKIM1; p=\n');
	});

	test('when the DNS did not answer and nothing else is wrong, it exits 5', async () => {
		const { bumail, key } = await server();
		const { code, out } = await bumail(CHECK, {
			...published(key),
			'_dmarc.example.com': { error: 'TEMPORARY' },
		});
		expect(code).toBe(5);
		expect(out).toContain('  unavailable TXT  _dmarc.example.com');
		expect(out).toEndWith('1 unavailable: bumail dns prints what to publish\n');
		const wrong = await bumail(CHECK, {
			...published(key),
			'_dmarc.example.com': { error: 'TEMPORARY' },
			'example.com': { txt: ['v=spf1 mx -all'] },
		});
		expect(wrong.code).toBe(1);
	});

	test('records are compared as parsed: white space, case, defaults, a split TXT and an MX spelling', async () => {
		const { bumail, key } = await server();
		const half = Math.floor(key.record.length / 2);
		const spaced = key.record.replace('v=DKIM1; k=rsa;', 'V=DKIM1;k=rsa ;');
		const { code, out } = await bumail(CHECK, {
			...published(key),
			'MAIL.example.com.': { a: ['192.0.2.10'] },
			'example.com': {
				mx: [{ exchange: 'MAIL.Example.com.', priority: 10 }],
				txt: ['  V=SPF1   MX  -ALL '],
			},
			[key.name]: { txt: [[spaced.slice(0, half), spaced.slice(half)]] },
			'_dmarc.example.com': {
				txt: [
					'v=DMARC1;p=quarantine;ADKIM=S;rua=mailto:postmaster@example.com;aspf=r;pct=100',
				],
			},
		});
		expect(out).not.toContain('differs');
		expect(code).toBe(0);
	});

	test('a TXT at the name that is another kind of record is not a difference', async () => {
		const { bumail, key } = await server();
		const { code, out } = await bumail(CHECK, {
			...published(key),
			'_dmarc.example.com': { txt: ['something else'] },
		});
		expect(code).toBe(1);
		expect(out).toContain('  missing     TXT  _dmarc.example.com');
	});

	test('the reverse DNS must name the host', async () => {
		const { bumail, key } = await server();
		const records = published(key);
		const wrong = await bumail(CHECK, {
			...records,
			'192.0.2.10': { ptr: ['static.provider.example'] },
		});
		expect(wrong.code).toBe(1);
		expect(wrong.out).toContain(
			'  differs     PTR  192.0.2.10  mail.example.com\n',
		);
		expect(wrong.out).toContain('found  static.provider.example');
		const none = await bumail(CHECK, { ...records, '192.0.2.10': {} });
		expect(none.code).toBe(1);
		expect(none.out).toContain('  missing     PTR  192.0.2.10');
	});

	test('without --ip the host name only has to resolve, and no PTR is looked up', async () => {
		const { bumail, key } = await server();
		const records = published(key);
		const args = ['dns', 'example.com', '--check'];
		const ok = await bumail(args, records);
		expect(ok.code).toBe(0);
		expect(ok.out).toContain(
			'  ok          A    mail.example.com  (any address)\n',
		);
		expect(ok.out).not.toContain('PTR');
		const none = await bumail(args, { ...records, 'mail.example.com': {} });
		expect(none.code).toBe(1);
		expect(none.out).toContain(
			'  missing     A    mail.example.com  (any address)\n',
		);
		const aaaa = await bumail(args, {
			...records,
			'mail.example.com': { aaaa: ['2001:0db8:0:0:0:0:0:10'] },
		});
		expect(aaaa.code).toBe(0);
	});

	test('a domain with no DKIM key is checked without it', async () => {
		const { bumail } = await server();
		const { code, out } = await bumail(['dns', 'example.org', '--check'], {
			'mail.example.com': { a: ['192.0.2.10'] },
			'example.org': {
				mx: [{ exchange: 'mail.example.com', priority: 10 }],
				txt: ['v=spf1 mx -all'],
			},
			'_dmarc.example.org': { txt: ['v=DMARC1; p=none; adkim=s'] },
		});
		expect(code).toBe(0);
		expect(out).not.toContain('_domainkey');
	});

	test('--json adds what was found, and whether all is well', async () => {
		const { bumail, key } = await server();
		const { code, out } = await bumail([...CHECK, '--json'], {
			...published(key),
			'example.com': { txt: ['v=spf1 a -all'] },
		});
		expect(code).toBe(1);
		const json = JSON.parse(out);
		expect(json.ok).toBe(false);
		const by = (type: string, name: string) =>
			json.checks.find(
				(c: { type: string; name: string }) =>
					c.type === type && c.name === name,
			);
		expect(by('A', 'mail.example.com')).toMatchObject({ status: 'ok' });
		expect(by('TXT', 'example.com')).toMatchObject({
			status: 'differs',
			found: ['v=spf1 a -all'],
			value: 'v=spf1 mx -all',
		});
		expect(by('MX', 'example.com')).toMatchObject({
			status: 'missing',
			found: [],
		});
		expect(by('SRV', '_imaps._tcp.example.com')).toMatchObject({
			status: 'unchecked',
		});
		const down = await bumail([...CHECK, '--json'], {
			...published(key),
			'_dmarc.example.com': { error: 'TIMEOUT' },
		});
		expect(down.code).toBe(5);
		expect(
			JSON.parse(down.out).checks.find(
				(c: { status: string }) => c.status === 'unavailable',
			),
		).toMatchObject({
			detail: 'The fixture answers TXT _dmarc.example.com with TIMEOUT',
		});
	});
});

describe('bumail dns with a stored key it cannot write', () => {
	test.each([
		['not base64!', 'dkimRecord(): publicKey is not base64'],
		[
			'QUJD',
			'dkimRecord(): an rsa publicKey is a DER SubjectPublicKeyInfo naming rsaEncryption',
		],
		[
			'',
			'the stored DKIM key of example.com is empty; bumail dkim generate example.com --replace makes a new one',
		],
	])(
		'%j is an error with a message, not a stack trace or a record',
		async (stored, message) => {
			const { bumail, data } = await server();
			const db = new Database(join(data, 'directory.sqlite'));
			db.query('UPDATE dkim_keys SET public_key = ?').run(stored);
			db.close();
			const { code, out, err } = await bumail(['dns']);
			expect(code).toBe(4);
			expect(out).toBe('');
			expect(err).toBe(
				`bumail: the DNS records cannot be written: ${message}\n`,
			);
		},
	);
});

describe('bumail dns refuses', () => {
	test('a domain that is not hosted, one that is no name, and a directory with none', async () => {
		const { bumail } = await server();
		expect(await bumail(['dns', 'example.net'])).toEqual({
			code: 4,
			out: '',
			err: 'bumail: the domain example.net is not hosted here; add it first\n',
		});
		expect((await bumail(['dns', 'not a domain'])).err).toBe(
			'bumail: "not a domain" is not a domain name\n',
		);
		const empty = tempDir();
		const config = join(empty, 'bumail.toml');
		writeFileSync(
			config,
			`hostname = "mail.example.com"\ndata = "${empty}"\n${ACME}`,
		);
		let err = '';
		const code = await run(['--config', config, 'dns'], {
			out: () => {},
			err: (text) => {
				err += text;
			},
			env: {},
			version: '0',
			terminal: { stdin: async () => '', isTTY: false, prompt: async () => '' },
		});
		expect(code).toBe(4);
		expect(err).toBe(
			'bumail: no domain is hosted here; bumail domain add adds one\n',
		);
	});

	test.each([
		[['dns', 'a.example', 'b.example'], 'dns takes a domain at most, not …'],
		[['dns', '--ip', '2001:db8::1'], '--ip takes an IPv4 address'],
		[['dns', '--ip6', '192.0.2.1'], '--ip6 takes an IPv6 address'],
		[['dns', '--ip'], '--ip needs an IPv4 address'],
		[['dns', '--ip6='], '--ip6 needs an IPv6 address'],
		[['dns', '--ip', '192.0.2.1', '--ip=192.0.2.2'], '--ip is given twice'],
		[['dns', '--purge'], 'dns takes no --purge'],
		[['dns', '--selector', 'x'], 'dns takes no --selector'],
		[['dns', '--password-stdin'], 'dns takes no --password-stdin'],
		[['check-config', '--json'], 'check-config takes no --json'],
		[['serve', '--check'], 'serve takes no --check'],
		[['domain', 'list', '--ip', '192.0.2.1'], 'domain list takes no --ip'],
		[['dkim', 'list', '--ip6', '2001:db8::1'], 'dkim list takes no --ip6'],
	])('%j', async (argv, message) => {
		const { bumail } = await server();
		const { code, err } = await bumail(argv);
		expect(code).toBe(2);
		expect(err).toBe(`bumail: ${message}; see bumail --help\n`);
	});
});
