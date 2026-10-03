import { describe, expect, test } from 'bun:test';
import { parseContentDisposition, parseContentType } from './parameters';

describe('parseContentType', () => {
	test('RFC 2045 §5.1: type, subtype and a comment', () => {
		expect(
			parseContentType('text/plain; charset=us-ascii (Plain text)'),
		).toEqual({
			mediaType: 'text/plain',
			type: 'text',
			subtype: 'plain',
			parameters: { charset: 'us-ascii' },
		});
	});

	test('RFC 2045 §5.1: names are case-insensitive, quoted values are unquoted', () => {
		const type = parseContentType('Text/HTML; CHARSET="UTF-8"');
		expect(type.mediaType).toBe('text/html');
		expect(type.parameters).toEqual({ charset: 'UTF-8' });
	});

	test('a quoted value may hold specials', () => {
		expect(
			parseContentType('multipart/mixed; boundary="simple boundary; =?x?="')
				.parameters['boundary'],
		).toBe('simple boundary; =?x?=');
	});

	test('RFC 2045 §5.2: missing or unreadable is text/plain; charset=us-ascii', () => {
		expect(parseContentType(undefined).mediaType).toBe('text/plain');
		const broken = parseContentType('garbage; charset=utf-8');
		expect(broken.mediaType).toBe('text/plain');
		expect(broken.parameters['charset']).toBe('utf-8');
	});

	// RFC 2231, its examples.
	test('RFC 2231 §3: continuations', () => {
		const type = parseContentType(
			'message/external-body; access-type=URL;\r\n URL*0="ftp://";\r\n URL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar"',
		);
		expect(type.parameters['url']).toBe(
			'ftp://cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar',
		);
		expect(type.parameters['access-type']).toBe('URL');
	});

	test('RFC 2231 §4: charset, language and percent-encoding', () => {
		expect(
			parseContentType(
				"application/x-stuff;\r\n title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A",
			).parameters['title'],
		).toBe('This is ***fun***');
	});

	test('RFC 2231 §4.1: encoded and plain continuations mixed', () => {
		expect(
			parseContentType(
				"application/x-stuff;\r\n title*0*=us-ascii'en'This%20is%20even%20more%20;\r\n title*1*=%2A%2A%2Afun%2A%2A%2A%20;\r\n title*2=\"isn't it!\"",
			).parameters['title'],
		).toBe("This is even more ***fun*** isn't it!");
	});

	test('RFC 2231 in UTF-8, sections out of order', () => {
		expect(
			parseContentType(
				"application/pdf; name*1*=%C3%A9.pdf; name*0*=utf-8''r%C3%A9sum",
			).parameters['name'],
		).toBe('résumé.pdf');
	});

	test('an encoded-word in a quoted value, as mail clients send it', () => {
		expect(
			parseContentType('application/pdf; name="=?UTF-8?B?csOpc3Vtw6kucGRm?="')
				.parameters['name'],
		).toBe('résumé.pdf');
	});
});

describe('parseContentDisposition', () => {
	test('RFC 2183 §2: type and filename', () => {
		expect(
			parseContentDisposition(
				'Attachment; filename=genome.jpeg;\r\n modification-date="Wed, 12 Feb 1997 16:29:51 -0500";',
			),
		).toEqual({
			type: 'attachment',
			parameters: {
				filename: 'genome.jpeg',
				'modification-date': 'Wed, 12 Feb 1997 16:29:51 -0500',
			},
		});
	});
});

describe('RFC 2231 sections, very long', () => {
	test('are joined without a RangeError', () => {
		const value = parseContentDisposition(
			`attachment; filename*0*=utf-8''${'%41'.repeat(1_000_000)}; filename*1*=${'%41'.repeat(1_000_000)}`,
		);
		expect(value.parameters.filename).toHaveLength(2_000_000);
	});
});
