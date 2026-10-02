import { describe, expect, test } from 'bun:test';
import { formatDate, parseDate } from './date';

describe('parseDate', () => {
	// RFC 5322 Appendix A, the dates of its examples.
	test.each([
		['A.1.1', 'Fri, 21 Nov 1997 09:55:06 -0600', '1997-11-21T15:55:06.000Z'],
		['A.1.2', 'Tue, 1 Jul 2003 10:52:37 +0200', '2003-07-01T08:52:37.000Z'],
		['A.1.3', 'Thu, 13 Feb 1969 23:32:54 -0330', '1969-02-14T03:02:54.000Z'],
		[
			'A.5, folded with a comment',
			'Thu,\r\n      13\r\n        Feb\r\n          1969\r\n      23:32\r\n               -0330 (Newfoundland Time)',
			'1969-02-14T03:02:00.000Z',
		],
		[
			'A.6.2, obsolete year and zone',
			'21 Nov 97 09:55:06 GMT',
			'1997-11-21T09:55:06.000Z',
		],
		[
			'§4.3, a named US zone',
			'Mon, 1 Jan 2001 12:00:00 EST',
			'2001-01-01T17:00:00.000Z',
		],
		[
			'§4.3, a military zone reads as UTC',
			'Mon, 1 Jan 2001 12:00:00 A',
			'2001-01-01T12:00:00.000Z',
		],
		[
			'§4.3, a three-digit year',
			'1 Jan 101 00:00:00 +0000',
			'2001-01-01T00:00:00.000Z',
		],
		[
			'no day of week, no seconds',
			'2 Oct 2026 18:00 -0400',
			'2026-10-02T22:00:00.000Z',
		],
	])('RFC 5322 %s', (_, value, iso) => {
		expect(parseDate(value)?.toISOString()).toBe(iso);
	});

	test('what is not a date', () => {
		expect(parseDate('yesterday')).toBeUndefined();
		expect(parseDate('31 Foo 2020 10:00:00 +0000')).toBeUndefined();
		expect(parseDate('31 Feb 2024 10:00:00 +0000')).toBeUndefined();
		expect(parseDate('1 Feb 2024 25:61:00 +0000')).toBeUndefined();
	});

	test('a leap second reads as 59', () => {
		expect(parseDate('31 Dec 2016 23:59:60 +0000')?.toISOString()).toBe(
			'2016-12-31T23:59:59.000Z',
		);
	});
});

describe('formatDate', () => {
	test('RFC 5322 §3.3, in UTC, and reads back', () => {
		const date = new Date('2026-10-02T22:05:09Z');
		expect(formatDate(date)).toBe('Fri, 02 Oct 2026 22:05:09 +0000');
		expect(parseDate(formatDate(date))?.getTime()).toBe(date.getTime());
	});

	test('a year outside 1900–9999 is refused with INVALID_OPTION', () => {
		for (const year of [999, 1899, 10000]) {
			const date = new Date(Date.UTC(2000, 0, 1));
			date.setUTCFullYear(year);
			expect(() => formatDate(date)).toThrow(
				`formatDate(): the year ${year} is outside 1900–9999`,
			);
		}
		expect(formatDate(new Date(Date.UTC(1900, 0, 1)))).toBe(
			'Mon, 01 Jan 1900 00:00:00 +0000',
		);
	});
});
