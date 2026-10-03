import { describe, expect, test } from 'bun:test';
import { isDmarcRecord, parseDmarcRecord, parseUri } from './record';

describe('isDmarcRecord (RFC 7489 §6.6.3 steps 2 and 4)', () => {
	test.each([
		['v=DMARC1; p=none', true],
		['v=DMARC1', true],
		['  v = DMARC1 ;p=reject', true],
		['V=DMARC1; p=none', true],
		['v=dmarc1; p=none', false],
		['v=DMARC2; p=none', false],
		['v=DMARC1x; p=none', false],
		['p=none; v=DMARC1', false],
		['v=spf1 -all', false],
		['', false],
	])('%p → %p', (text, is) => {
		expect(isDmarcRecord(text)).toBe(is);
	});
});

describe('parseDmarcRecord (§6.3)', () => {
	test('every tag left out takes its default', () => {
		expect(parseDmarcRecord('v=DMARC1; p=none')).toEqual({
			p: 'none',
			invalidSp: false,
			adkim: 'r',
			aspf: 'r',
			pct: 100,
			rua: [],
			ruf: [],
			fo: ['0'],
			rf: ['afrf'],
			ri: 86_400,
		});
	});

	test('every tag read', () => {
		expect(
			parseDmarcRecord(
				'v=DMARC1; p=reject; sp=quarantine; adkim=s; aspf=s; pct=20; ' +
					'rua=mailto:a@example.com; ruf=mailto:f@example.com; fo=1:d:s; rf=afrf; ri=3600',
			),
		).toEqual({
			p: 'reject',
			sp: 'quarantine',
			invalidSp: false,
			adkim: 's',
			aspf: 's',
			pct: 20,
			rua: [{ uri: 'mailto:a@example.com' }],
			ruf: [{ uri: 'mailto:f@example.com' }],
			fo: ['1', 'd', 's'],
			rf: ['afrf'],
			ri: 3600,
		});
	});

	test('names and policy values ignore case, as ABNF strings do', () => {
		expect(
			parseDmarcRecord('v=DMARC1; P=Reject; SP=NONE; ADKIM=S'),
		).toMatchObject({ p: 'reject', sp: 'none', adkim: 's' });
	});

	test('unknown tags are ignored, and a tag given twice keeps its first value', () => {
		expect(
			parseDmarcRecord('v=DMARC1; p=quarantine; np=reject; p=none; x; =y'),
		).toMatchObject({ p: 'quarantine', invalidSp: false });
	});

	test('a value written wrong takes the default', () => {
		expect(
			parseDmarcRecord(
				'v=DMARC1; p=none; adkim=x; aspf=; pct=101; fo=0:x; rf=a f; ri=-1',
			),
		).toMatchObject({
			adkim: 'r',
			aspf: 'r',
			pct: 100,
			fo: ['0'],
			rf: ['afrf'],
			ri: 86_400,
		});
		expect(parseDmarcRecord('v=DMARC1; p=none; pct=1000').pct).toBe(100);
		expect(parseDmarcRecord('v=DMARC1; p=none; ri=4294967296').ri).toBe(86_400);
		expect(parseDmarcRecord('v=DMARC1; p=none; pct=0').pct).toBe(0);
	});

	test('a bad p= is absent; a bad sp= is absent and flagged', () => {
		expect(parseDmarcRecord('v=DMARC1; p=block').p).toBeUndefined();
		expect(parseDmarcRecord('v=DMARC1').p).toBeUndefined();
		const record = parseDmarcRecord('v=DMARC1; p=none; sp=maybe');
		expect(record.sp).toBeUndefined();
		expect(record.invalidSp).toBe(true);
	});

	test('rua keeps the URIs that parse, with their sizes', () => {
		expect(
			parseDmarcRecord(
				'v=DMARC1; p=none; rua=mailto:a@example.com!10m , not a uri, mailto:b@example.net!50, https://r.example/x!2k',
			).rua,
		).toEqual([
			{ uri: 'mailto:a@example.com', maxSize: 10 * 2 ** 20 },
			{ uri: 'mailto:b@example.net', maxSize: 50 },
			{ uri: 'https://r.example/x', maxSize: 2048 },
		]);
	});
});

describe('parseUri (§6.2, §6.4)', () => {
	test.each([
		['mailto:x@example.com', { uri: 'mailto:x@example.com' }],
		[
			'mailto:x@example.com!1t',
			{ uri: 'mailto:x@example.com', maxSize: 2 ** 40 },
		],
		[
			'mailto:x@example.com!1G',
			{ uri: 'mailto:x@example.com', maxSize: 2 ** 30 },
		],
		['mailto:x@example.com!', undefined],
		['mailto:x@example.com!10x', undefined],
		['mailto:x@example.com!99999999999999999999', undefined],
		['mailto:', undefined],
		['x@example.com', undefined],
		['1mailto:x@example.com', undefined],
		['mailto:x y@example.com', undefined],
	])('%p', (text, uri) => {
		expect(parseUri(text)).toEqual(uri);
	});
});
