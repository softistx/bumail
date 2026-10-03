import { describe, expect, test } from 'bun:test';
import { canonicalizeHeader, withoutSignatureValue } from './canon';
import { selectFields, splitFields } from './headers';

describe('splitFields', () => {
	test('keeps each field as written, folding and all, line ends as CRLF', () => {
		expect(splitFields('Subject: a\n b\r\nFROM : x\r\n')).toEqual([
			{ name: 'subject', raw: 'Subject: a\r\n b' },
			{ name: 'from', raw: 'FROM : x' },
		]);
	});

	test('skips a line with no colon and a continuation with no field', () => {
		expect(
			splitFields(' orphan\r\nno colon\r\n: empty name\r\nTo: y\r\n'),
		).toEqual([{ name: 'to', raw: 'To: y' }]);
	});
});

describe('selectFields (RFC 6376 §5.4.2)', () => {
	const fields = splitFields('To: 1\r\nFrom: a\r\nTo: 2\r\nTo: 3\r\n');

	test('takes each name bottom-up, one instance per mention', () => {
		expect(
			selectFields(fields, ['to', 'from', 'To']).map((f) => f.raw),
		).toEqual(['To: 3', 'From: a', 'To: 2']);
	});

	test('a name listed more often than present selects nothing more', () => {
		expect(
			selectFields(fields, ['from', 'from', 'subject', 'from']).map(
				(f) => f.raw,
			),
		).toEqual(['From: a']);
	});
});

describe('canonicalizeHeader and withoutSignatureValue', () => {
	test('relaxed lowercases ASCII only, so no non-ASCII byte changes', () => {
		expect(canonicalizeHeader('X-\u00c9t\u00c9: v', 'relaxed')).toBe(
			'x-\u00c9t\u00c9:v\r\n',
		);
	});

	test('relaxed does not trim a non-breaking space, which is a byte of the value', () => {
		expect(canonicalizeHeader('Subject: \u00a0x\u00a0', 'relaxed')).toBe(
			'subject:\u00a0x\u00a0\r\n',
		);
	});

	test('deletes the value of b=, folding included, and leaves bh=', () => {
		expect(
			withoutSignatureValue('DKIM-Signature: bh=abc; b=de\r\n f; d=x'),
		).toBe('DKIM-Signature: bh=abc; b=; d=x');
		expect(withoutSignatureValue('DKIM-Signature: v=1;\r\n b = xyz')).toBe(
			'DKIM-Signature: v=1;\r\n b =',
		);
	});
});
