import { describe, expect, test } from 'bun:test';
import { DnsError } from './errors';
import { fixtureResolver } from './fixture';
import { formatZone, type ZoneRecord } from './zone';

/** The character-strings of a TXT line, unescaped, as a zone-file reader joins them. */
function txtOf(zone: string): string {
	const rdata = zone.trimEnd().split(' IN TXT ')[1] ?? '';
	const strings = [...rdata.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
	return strings
		.join('')
		.replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d)))
		.replace(/\\(.)/g, '$1');
}

describe('formatZone', () => {
	test('writes one BIND line per record, names absolute', () => {
		expect(
			formatZone([
				{
					name: 'Example.COM',
					type: 'MX',
					priority: 10,
					value: 'mail.example.com',
				},
				{ name: 'mail.example.com.', type: 'A', ttl: 3600, value: '192.0.2.1' },
				{ name: 'mail.example.com', type: 'AAAA', value: '2001:db8::1' },
				{ name: 'www.example.com', type: 'CNAME', value: 'example.com.' },
				{ name: 'example.com', type: 'NS', value: 'ns1.example.net' },
				{ name: 'example.com', type: 'TXT', ttl: 300, value: 'v=spf1 mx -all' },
				{
					name: '_imaps._tcp.example.com',
					type: 'SRV',
					priority: 0,
					value: '1 993 mail.example.com',
				},
				{ name: 'example.com', type: 'CAA', value: '0 issue letsencrypt.org' },
				{
					name: '1.2.0.192.in-addr.arpa',
					type: 'PTR',
					value: 'mail.example.com',
				},
			]),
		).toBe(
			[
				'example.com. IN MX 10 mail.example.com.',
				'mail.example.com. 3600 IN A 192.0.2.1',
				'mail.example.com. IN AAAA 2001:db8::1',
				'www.example.com. IN CNAME example.com.',
				'example.com. IN NS ns1.example.net.',
				'example.com. 300 IN TXT "v=spf1 mx -all"',
				'_imaps._tcp.example.com. IN SRV 0 1 993 mail.example.com.',
				'example.com. IN CAA 0 issue "letsencrypt.org"',
				'1.2.0.192.in-addr.arpa. IN PTR mail.example.com.',
				'',
			].join('\n'),
		);
	});

	test('no records is no text; an IDN is written in A-labels', () => {
		expect(formatZone([])).toBe('');
		expect(
			formatZone([{ name: 'bücher.example', type: 'A', value: '192.0.2.1' }]),
		).toBe('xn--bcher-kva.example. IN A 192.0.2.1\n');
	});

	test('a null MX keeps its dot', () => {
		expect(
			formatZone([
				{ name: 'example.net', type: 'MX', priority: 0, value: '.' },
			]),
		).toBe('example.net. IN MX 0 .\n');
	});

	test('a CAA value already quoted is not quoted twice', () => {
		expect(
			formatZone([
				{ name: 'example.com', type: 'CAA', value: '128 issuewild ";"' },
			]),
		).toBe('example.com. IN CAA 128 issuewild ";"\n');
	});
});

describe('formatZone TXT', () => {
	test('quotes and backslashes are escaped, control characters are decimal', () => {
		const value = 'say "hi" \\ there\ttab';
		const zone = formatZone([{ name: 'example.com', type: 'TXT', value }]);
		expect(zone).toBe(
			'example.com. IN TXT "say \\"hi\\" \\\\ there\\009tab"\n',
		);
		expect(txtOf(zone)).toBe(value);
	});

	test('a value over 255 bytes is split into strings of 255 bytes at most', () => {
		const value = `v=DKIM1; k=rsa; p=${'A'.repeat(600)}`;
		const zone = formatZone([
			{ name: 'bumail._domainkey.example.com', type: 'TXT', value },
		]);
		const strings = [...zone.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
		expect(strings.map((s) => s.length)).toEqual([255, 255, 108]);
		expect(txtOf(zone)).toBe(value);
	});

	test('exactly 255 bytes is one string', () => {
		const zone = formatZone([
			{ name: 'example.com', type: 'TXT', value: 'x'.repeat(255) },
		]);
		expect([...zone.matchAll(/"/g)]).toHaveLength(2);
	});

	test('a character is never cut: the limit counts UTF-8 bytes', () => {
		const value = 'é'.repeat(200); // 400 bytes
		const zone = formatZone([{ name: 'example.com', type: 'TXT', value }]);
		const strings = [...zone.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
		expect(strings.map((s) => new TextEncoder().encode(s).length)).toEqual([
			254, 146,
		]);
		expect(txtOf(zone)).toBe(value);
	});

	test('an empty value is one empty string', () => {
		expect(formatZone([{ name: 'example.com', type: 'TXT', value: '' }])).toBe(
			'example.com. IN TXT ""\n',
		);
	});

	test('what a resolver joins is the value that was given', async () => {
		const value = `v=DKIM1; k=rsa; p=${'Qk'.repeat(500)}`;
		const zone = formatZone([
			{ name: 'k._domainkey.example.com', type: 'TXT', value },
		]);
		const strings = [...zone.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
		const dns = fixtureResolver({
			'k._domainkey.example.com': { txt: [strings] },
		});
		expect((await dns.txt('k._domainkey.example.com'))[0]?.text).toBe(value);
	});
});

describe('formatZone refuses', () => {
	const refused = (
		record: ZoneRecord | null,
		code: DnsError['code'],
		message: string,
	) => {
		try {
			formatZone([record as ZoneRecord]);
			throw new Error('did not throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DnsError);
			expect((error as DnsError).code).toBe(code);
			expect((error as DnsError).message).toContain(message);
		}
	};

	test('a name no zone holds', () => {
		refused(
			{ name: 'a b.example', type: 'A', value: '192.0.2.1' },
			'INVALID_NAME',
			'formatZone(): records[0]: name:',
		);
		refused(
			{ name: '192.0.2.1', type: 'A', value: '192.0.2.1' },
			'INVALID_NAME',
			'name:',
		);
	});

	test('a value the type cannot hold', () => {
		refused(
			{ name: 'x.example', type: 'A', value: '2001:db8::1' },
			'INVALID_OPTION',
			'is not an IPv4 address',
		);
		refused(
			{ name: 'x.example', type: 'AAAA', value: '192.0.2.1' },
			'INVALID_OPTION',
			'is not an IPv6 address',
		);
		refused(
			{ name: 'x.example', type: 'CNAME', value: 'a b' },
			'INVALID_OPTION',
			'is not a host name',
		);
		refused(
			{ name: 'x.example', type: 'CNAME', value: '.' },
			'INVALID_OPTION',
			'is not a host name',
		);
		refused(
			{
				name: 'x.example',
				type: 'SRV',
				priority: 0,
				value: '1 99999 h.example',
			},
			'INVALID_OPTION',
			'"<weight> <port> <target>"',
		);
		refused(
			{ name: 'x.example', type: 'SRV', priority: 0, value: 'h.example' },
			'INVALID_OPTION',
			'"<weight> <port> <target>"',
		);
		refused(
			{ name: 'x.example', type: 'CAA', value: 'issue letsencrypt.org' },
			'INVALID_OPTION',
			'"<flags> <tag> <value>"',
		);
		refused(
			{ name: 'x.example', type: 'TXT', value: 7 as never },
			'INVALID_OPTION',
			'value must be a string',
		);
	});

	test('a priority missing, or where the type has none', () => {
		refused(
			{ name: 'x.example', type: 'MX', value: 'm.example' },
			'INVALID_OPTION',
			'MX records need a priority',
		);
		refused(
			{ name: 'x.example', type: 'SRV', value: '1 1 m.example' },
			'INVALID_OPTION',
			'SRV records need a priority',
		);
		refused(
			{ name: 'x.example', type: 'A', priority: 1, value: '192.0.2.1' },
			'INVALID_OPTION',
			'A records take no priority',
		);
		refused(
			{ name: 'x.example', type: 'MX', priority: 70_000, value: 'm.example' },
			'INVALID_OPTION',
			'priority must be an integer from 0 to 65535',
		);
	});

	test('a TTL out of range, a type unknown, a record that is not one', () => {
		refused(
			{ name: 'x.example', type: 'A', ttl: -1, value: '192.0.2.1' },
			'INVALID_OPTION',
			'ttl must be an integer',
		);
		refused(
			{ name: 'x.example', type: 'A', ttl: 1.5, value: '192.0.2.1' },
			'INVALID_OPTION',
			'ttl must be an integer',
		);
		refused(
			{ name: 'x.example', type: 'SOA' as never, value: '' },
			'INVALID_OPTION',
			'the type "SOA"',
		);
		refused(null, 'INVALID_OPTION', 'records[0]: must be an object');
		expect(() => formatZone('x' as never)).toThrow('records must be an array');
	});

	test('names the record by its index', () => {
		expect(() =>
			formatZone([
				{ name: 'x.example', type: 'A', value: '192.0.2.1' },
				{ name: 'x.example', type: 'A', value: 'nope' },
			]),
		).toThrow('records[1]');
	});
});
