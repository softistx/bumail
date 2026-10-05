import { describe, expect, test } from 'bun:test';
import { sameDkimRecord, sameDmarcRecord, sameSpfRecord } from './same';
import { spfRecord } from './spf';

describe('sameSpfRecord', () => {
	test.each([
		['v=spf1 mx -all', 'v=spf1 mx -all'],
		['v=spf1 mx -all', 'V=SPF1   MX  -ALL '],
		['v=spf1 +mx -all', 'v=spf1 mx -all'],
		['v=spf1 mx/32//128 -all', 'v=spf1 mx -all'],
		['v=spf1 ip6:2001:DB8:0:0::1 -all', 'v=spf1 ip6:2001:db8::1/128 -all'],
		[
			'v=spf1 include:_SPF.Relay.example -all',
			'v=spf1 include:_spf.relay.example -all',
		],
	])('%j is %j', (a, b) => {
		expect(sameSpfRecord(a, b)).toBe(true);
		expect(sameSpfRecord(b, a)).toBe(true);
	});

	test.each([
		['v=spf1 mx -all', 'v=spf1 a -all'],
		['v=spf1 mx -all', 'v=spf1 mx ~all'],
		['v=spf1 mx -all', 'v=spf1 mx/24 -all'],
		['v=spf1 a mx -all', 'v=spf1 mx a -all'],
		['v=spf1 ip4:192.0.2.1 -all', 'v=spf1 ip4:192.0.2.2 -all'],
		['v=spf1 mx -all', 'v=spf1 mx'],
	])('%j is not %j', (a, b) => {
		expect(sameSpfRecord(a, b)).toBe(false);
	});

	test('a text checkSpf cannot read is the same as nothing', () => {
		expect(sameSpfRecord('v=spf1 bogus', 'v=spf1 bogus')).toBe(false);
		expect(sameSpfRecord('hello', 'hello')).toBe(false);
	});

	test('what spfRecord writes is the same as itself', () => {
		const text = spfRecord({ a: true, mx: true, ip4: ['192.0.2.0/24'] });
		expect(sameSpfRecord(text, text)).toBe(true);
	});
});

describe('sameDmarcRecord', () => {
	test.each([
		['v=DMARC1; p=none', 'v=DMARC1;p=none;'],
		['v=DMARC1; p=none', 'v=DMARC1; P=NONE; adkim=r; aspf=r; pct=100'],
		['v=DMARC1; p=quarantine; adkim=s', 'v=DMARC1; adkim=S; p=quarantine'],
	])('%j is %j', (a, b) => {
		expect(sameDmarcRecord(a, b)).toBe(true);
	});

	test.each([
		['v=DMARC1; p=none', 'v=DMARC1; p=reject'],
		['v=DMARC1; p=none', 'v=DMARC1; p=none; adkim=s'],
		['v=DMARC1; p=none', 'v=DMARC1; p=none; rua=mailto:a@example.com'],
		['v=DMARC1; p=none', 'p=none'],
	])('%j is not %j', (a, b) => {
		expect(sameDmarcRecord(a, b)).toBe(false);
	});
});

describe('sameDkimRecord', () => {
	test.each([
		['v=DKIM1; k=rsa; p=QUJD', 'v=DKIM1; p=QUJD'],
		['v=DKIM1; k=rsa; p=QUJD', 'v=DKIM1;k=rsa;p=QU JD;'],
		['v=DKIM1; k=rsa; t=y:s; p=QUJD', 'v=DKIM1; k=rsa; t=s:y; p=QUJD'],
	])('%j is %j', (a, b) => {
		expect(sameDkimRecord(a, b)).toBe(true);
	});

	test.each([
		['v=DKIM1; k=rsa; p=QUJD', 'v=DKIM1; k=rsa; p=QUJE'],
		['v=DKIM1; k=rsa; p=QUJD', 'v=DKIM1; k=ed25519; p=QUJD'],
		['v=DKIM1; k=rsa; p=QUJD', 'v=DKIM1; k=rsa; t=y; p=QUJD'],
		['v=DKIM1; k=rsa; p=QUJD', 'v=spf1 -all'],
	])('%j is not %j', (a, b) => {
		expect(sameDkimRecord(a, b)).toBe(false);
	});
});
