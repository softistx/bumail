import { describe, expect, test } from 'bun:test';
import { parseDmarcRecord } from '../dmarc/record';
import { type DmarcRecordOptions, dmarcRecord } from './dmarc';

describe('dmarcRecord writes what parseDmarcRecord reads', () => {
	test('only the policy', () => {
		expect(dmarcRecord({ p: 'none' })).toBe('v=DMARC1; p=none');
		expect(parseDmarcRecord('v=DMARC1; p=none')).toMatchObject({ p: 'none' });
	});

	test('every tag round-trips', () => {
		const text = dmarcRecord({
			p: 'quarantine',
			sp: 'reject',
			adkim: 's',
			aspf: 's',
			pct: 25,
			rua: ['postmaster@example.com', 'https://reports.example/rua!10m'],
			ruf: 'mailto:forensic@example.com',
		});
		expect(text).toBe(
			'v=DMARC1; p=quarantine; sp=reject; adkim=s; aspf=s; pct=25; rua=mailto:postmaster@example.com,https://reports.example/rua!10m; ruf=mailto:forensic@example.com',
		);
		expect(parseDmarcRecord(text)).toMatchObject({
			p: 'quarantine',
			sp: 'reject',
			invalidSp: false,
			adkim: 's',
			aspf: 's',
			pct: 25,
			rua: [
				{ uri: 'mailto:postmaster@example.com' },
				{ uri: 'https://reports.example/rua', maxSize: 10 * 2 ** 20 },
			],
			ruf: [{ uri: 'mailto:forensic@example.com' }],
		});
	});

	test('a tag at its default is left out', () => {
		expect(dmarcRecord({ p: 'reject', adkim: 'r', aspf: 'r', pct: 100 })).toBe(
			'v=DMARC1; p=reject',
		);
		expect(dmarcRecord({ p: 'none', pct: 0 })).toBe('v=DMARC1; p=none; pct=0');
	});
});

describe('dmarcRecord refuses', () => {
	test.each<[DmarcRecordOptions, string]>([
		[{ p: 'block' as never }, 'p must be one of none, quarantine, reject'],
		[{ p: 'none', sp: 'x' as never }, 'sp must be one of'],
		[{ p: 'none', adkim: 'x' as never }, "adkim must be 'r' or 's'"],
		[{ p: 'none', aspf: 'strict' as never }, "aspf must be 'r' or 's'"],
		[{ p: 'none', pct: 101 }, 'pct must be an integer from 0 to 100'],
		[{ p: 'none', pct: 1.5 }, 'pct must be an integer from 0 to 100'],
		[{ p: 'none', rua: 'a b@example.com' }, 'rua "a b@example.com"'],
		[
			{ p: 'none', rua: 'a@example.com,b@example.com' },
			'rua "a@example.com,b@',
		],
		[{ p: 'none', ruf: 'mailto:' }, 'ruf "mailto:"'],
		[
			{ p: 'none', rua: 'postmaster' },
			'rua "postmaster" is not an e-mail address',
		],
		[
			{ p: 'none', ruf: 'mailto:nobody' },
			'ruf "mailto:nobody" is not an e-mail address',
		],
		[{ p: 'none', rua: [] }, 'rua must be an address'],
		[{ p: 'none', rua: [''] }, 'rua must hold addresses'],
	])('%j', (options, message) => {
		expect(() => dmarcRecord(options)).toThrow(message);
		try {
			dmarcRecord(options);
		} catch (error) {
			expect(error).toMatchObject({
				name: 'AuthError',
				code: 'INVALID_OPTION',
			});
		}
	});
});
