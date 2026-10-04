import { describe, expect, test } from 'bun:test';
import { fromAddresses } from './submission/sender';

const encoder = new TextEncoder();

/** The From addresses of a header whose From value is `value`. */
function authors(value: string): ReturnType<typeof fromAddresses> {
	return fromAddresses(encoder.encode(`From: ${value}\r\nSubject: x\r\n\r\n`));
}

const ME = '<alice@example.com>';

describe('fromAddresses: an @ hidden from the check is refused', () => {
	test.each([
		// Plainly written, in a display name, a quote or a comment.
		['a quoted local part', '<"ceo"@bank.example>'],
		['a domain literal', '<alice@[192.0.2.1]>'],
		['an @ on its own', `Alice @ ${ME}`],
		// One encoded-word.
		['Q, =40', `=?UTF-8?Q?ceo=40bank.example?= ${ME}`],
		['Q, lowercase =40', `=?utf-8?q?ceo=40bank.example?= ${ME}`],
		['Q, a raw @', `=?UTF-8?Q?ceo@bank.example?= ${ME}`],
		['B', `=?UTF-8?B?Y2VvQGJhbmsuZXhhbXBsZQ==?= ${ME}`],
		['B, lowercase b', `=?utf-8?b?Y2VvQGJhbmsuZXhhbXBsZQ==?= ${ME}`],
		['B, no padding', `=?UTF-8?B?Y2VvQGJhbmsuZXhhbXBsZQ?= ${ME}`],
		[
			'B, an address hidden in a word',
			`=?UTF-8?B?Y2VvQGJhbmsuZXhhbXBsZQ==?= =?UTF-8?B?${ME}?=`,
		],
		['Q in iso-8859-1', `=?ISO-8859-1?Q?ceo=40bank.example?= ${ME}`],
		['Q in windows-1252', `=?windows-1252?Q?ceo=40bank.example?= ${ME}`],
		['a language tag', `=?UTF-8*en?Q?ceo=40bank.example?= ${ME}`],
		['in a comment', `${ME} (=?UTF-8?Q?ceo=40bank.example?=)`],
		['in a quoted string', `"=?UTF-8?Q?ceo=40bank.example?=" ${ME}`],
		// Charsets not on the allow-list.
		['cp65001', `=?cp65001?Q?ceo=40bank.example?= ${ME}`],
		['UTF-7, Q', `=?UTF-7?Q?ceo=40bank.example?= ${ME}`],
		['UTF-7, +AEA-', `=?UTF-7?Q?ceo+AEA-bank.example?= ${ME}`],
		['UTF-7, B of +AEA-', `=?UTF-7?B?Y2VvK0FFQS1iYW5r?= ${ME}`],
		['x-bogus, Q', `=?x-bogus?Q?ceo=40bank.example?= ${ME}`],
		['x-bogus, B', `=?x-bogus?B?Y2VvQGJhbmsuZXhhbXBsZQ==?= ${ME}`],
		['UTF-16', `=?UTF-16?B?AGMAZQBvAEAAYgBhAG4Aaw==?= ${ME}`],
		['an empty charset', `=??Q?ceo?= ${ME}`],
		// Words that are not well-formed.
		['a space in Q text', `=?UTF-8?Q?ceo=40 bank?= ${ME}`],
		['a space in B text', `=?UTF-8?B?Y2VvQGJh bmsuZXhhbXBsZQ==?= ${ME}`],
		['a fold in a word', `=?UTF-8?Q?ceo=40\r\n bank?= ${ME}`],
		['a word never closed', `=?UTF-8?Q?ceo ${ME}`],
		['an encoding other than B or Q', `=?UTF-8?X?ceo?= ${ME}`],
		['a stray =?', `Alice =? ${ME}`],
		['a stray =? after a good word', `=?UTF-8?Q?Alice?= =? ${ME}`],
		// Split across adjacent words in one charset and encoding.
		['a Q escape split', `=?UTF-8?Q?ceo=4?==?UTF-8?Q?0bank?= ${ME}`],
		[
			'a Q escape split with a space',
			`=?UTF-8?Q?ceo=4?= =?UTF-8?Q?0bank?= ${ME}`,
		],
		[
			'a base64 group split',
			`=?UTF-8?B?Y2VvQ?==?UTF-8?B?GJhbmsuZXhhbXBsZQ==?= ${ME}`,
		],
		[
			'a base64 group split with a space',
			`=?UTF-8?B?Y2VvQ?= =?UTF-8?B?GJhbmsuZXhhbXBsZQ==?= ${ME}`,
		],
		[
			'a base64 split, padding in the first',
			`=?UTF-8?B?Y2Vv?==?UTF-8?B?QGJhbmsuZXhhbXBsZQ==?= ${ME}`,
		],
		[
			'a split in a later run',
			`=?UTF-8?Q?Alice?= =?UTF-8?Q?ceo=4?==?UTF-8?Q?0bank?= ${ME}`,
		],
	])('%s', (_, value) => {
		expect(authors(value)).toBe('unreadable');
	});
});

describe('fromAddresses: an address written plainly anywhere is an author', () => {
	test.each([
		['a quoted display name', `"ceo@bank.example" ${ME}`],
		['a bare display name', `ceo@bank.example ${ME}`],
		['a comment', `${ME} (ceo@bank.example)`],
	])('%s', (_, value) => {
		// Each is checked against the user: another's is refused.
		expect(authors(value)).toContain('ceo@bank.example');
	});
});

describe('fromAddresses: what a mail client writes is read', () => {
	test.each([
		['a plain address', 'alice@example.com', ['alice@example.com']],
		['a plain name', `Alice ${ME}`, ['alice@example.com']],
		['a quoted name', `"Alice, at work" ${ME}`, ['alice@example.com']],
		['a comment', 'alice@example.com (Alice)', ['alice@example.com']],
		[
			'a UTF-8 name, Q',
			`=?UTF-8?Q?Alice_M=C3=BCller?= ${ME}`,
			['alice@example.com'],
		],
		[
			'a UTF-8 name, B',
			`=?UTF-8?B?QWxpY2UgTcO8bGxlcg==?= ${ME}`,
			['alice@example.com'],
		],
		[
			'an iso-8859-1 name',
			`=?iso-8859-1?Q?Alice_M=FCller?= ${ME}`,
			['alice@example.com'],
		],
		[
			'a long name split across several words',
			`=?UTF-8?Q?Alice_M=C3=BCller-Schmidt_von_der?=\r\n =?UTF-8?Q?_Gr=C3=BCnen_Wiese_und_Sohn?= =?UTF-8?B?LCBEaXJla3Rvcmlu?= ${ME}`,
			['alice@example.com'],
		],
		[
			'two addresses',
			`Alice ${ME}, sales@example.com`,
			['alice@example.com', 'sales@example.com'],
		],
	])('%s', (_, value, expected) => {
		expect(authors(value)).toEqual(expected);
	});

	test('a From naming no address is none', () => {
		expect(authors('undisclosed:;')).toBe('none');
	});
});
