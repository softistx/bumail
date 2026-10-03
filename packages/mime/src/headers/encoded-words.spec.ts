import { describe, expect, test } from 'bun:test';
import {
	decodeEncodedWords,
	encodeHeaderValue,
	encodeWord,
} from './encoded-words';

describe('decodeEncodedWords', () => {
	// RFC 2047 §8, the examples of encoded headers.
	test('RFC 2047 §8: Q encoding in ISO-8859-1', () => {
		expect(decodeEncodedWords('=?ISO-8859-1?Q?Keld_J=F8rn_Simonsen?=')).toBe(
			'Keld Jørn Simonsen',
		);
		expect(decodeEncodedWords('=?ISO-8859-1?Q?Andr=E9?= Pirard')).toBe(
			'André Pirard',
		);
		expect(decodeEncodedWords('=?ISO-8859-1?Q?Olle_J=E4rnefors?=')).toBe(
			'Olle Järnefors',
		);
	});

	test('RFC 2047 §8: B encoding across two charsets, the space between dropped', () => {
		expect(
			decodeEncodedWords(
				'=?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?= =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=',
			),
		).toBe('If you can read this you understand the example.');
	});

	test('RFC 2047 §8: B encoding in ISO-8859-8', () => {
		expect(decodeEncodedWords('=?iso-8859-8?b?7eXs+SDv4SDp7Oj08A==?=')).toBe(
			'םולש ןב ילטפנ',
		);
	});

	// RFC 2047 §8, the table of white space between encoded-words.
	test.each([
		['(=?ISO-8859-1?Q?a?=)', '(a)'],
		['(=?ISO-8859-1?Q?a?= b)', '(a b)'],
		['(=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=)', '(ab)'],
		['(=?ISO-8859-1?Q?a?=  =?ISO-8859-1?Q?b?=)', '(ab)'],
		['(=?ISO-8859-1?Q?a?=\r\n    =?ISO-8859-1?Q?b?=)', '(ab)'],
		['(=?ISO-8859-1?Q?a_b?=)', '(a b)'],
		['(=?ISO-8859-1?Q?a?= =?ISO-8859-2?Q?_b?=)', '(a b)'],
	])('RFC 2047 §8: %s', (encoded, decoded) => {
		expect(decodeEncodedWords(encoded)).toBe(decoded);
	});

	test('RFC 2231 §5: a language after the charset', () => {
		expect(decodeEncodedWords('=?US-ASCII*EN?Q?Keith_Moore?=')).toBe(
			'Keith Moore',
		);
	});

	test('a UTF-8 character split across two words still reads', () => {
		// "é" is C3 A9; a sender cut it between the words.
		expect(decodeEncodedWords('=?UTF-8?Q?caf=C3?= =?UTF-8?Q?=A9?=')).toBe(
			'café',
		);
	});

	test('an unknown charset leaves the word as it is', () => {
		expect(decodeEncodedWords('=?x-unknown?Q?abc?= ok')).toBe(
			'=?x-unknown?Q?abc?= ok',
		);
	});

	test('text with no encoded-word is unchanged', () => {
		expect(decodeEncodedWords('Hello = world ?=')).toBe('Hello = world ?=');
	});
});

describe('encodeHeaderValue', () => {
	test('ASCII is left as it is', () => {
		expect(encodeHeaderValue('Saying Hello')).toBe('Saying Hello');
	});

	test('only the words that need it are encoded, and decode back', () => {
		const value = 'Réunion de lundi à 10h';
		const encoded = encodeHeaderValue(value);
		expect(encoded).toStartWith('=?UTF-8?B?');
		expect(encoded).toContain(' de lundi ');
		expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
		expect(decodeEncodedWords(encoded)).toBe(value);
	});

	test('the space inside a run of encoded words survives', () => {
		const value = 'Ελληνικά κείμενα ok';
		expect(decodeEncodedWords(encodeHeaderValue(value))).toBe(value);
	});

	test('text that looks like an encoded-word is encoded, so it reads back as written', () => {
		const value = 'literal =?utf-8?Q?x?= here';
		expect(decodeEncodedWords(encodeHeaderValue(value))).toBe(value);
	});

	test('RFC 2047 §2: no encoded-word is longer than 75 characters', () => {
		const words = encodeWord('日本語'.repeat(40)).split(' ');
		expect(words.length).toBeGreaterThan(1);
		for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
		expect(decodeEncodedWords(words.join(' '))).toBe('日本語'.repeat(40));
	});
});

/**
 * Hostile headers: tens of thousands of adjacent encoded-words in one
 * charset, which are decoded together, and long runs of `=?` that open no
 * word. Joining a run one word at a time cost the square of its length —
 * 100,000 adjacent `B` words took about 660 ms, twice as long as 50,000
 * took four times as long; collected and joined once they take a few tens
 * of milliseconds. The bound leaves CI a wide margin; the scaling check
 * catches a quadratic step a fast machine would hide under it.
 */
describe('decodeEncodedWords on hostile input takes linear time', () => {
	const BOUND_MS = 1000;

	/** The fastest of three runs, so a collection pause does not count. */
	function fastest(value: string): number {
		let best = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3; run++) {
			const start = performance.now();
			decodeEncodedWords(value);
			best = Math.min(best, performance.now() - start);
		}
		return best;
	}

	const shapes: [string, (n: number) => string, number][] = [
		[
			'adjacent B words, one charset',
			(n) => '=?UTF-8?B?YWJj?='.repeat(n),
			50_000,
		],
		[
			'adjacent Q words separated by spaces',
			(n) => '=?UTF-8?Q?a?= '.repeat(n),
			50_000,
		],
		[
			'adjacent words alternating charsets',
			(n) => '=?UTF-8?Q?a?==?ISO-8859-1?Q?b?='.repeat(n),
			25_000,
		],
		['runs of `=?` that open no word', (n) => '=?'.repeat(n), 200_000],
		['words left open', (n) => '=?utf-8?Q?a'.repeat(n), 100_000],
		[
			'words in an unknown charset after a known one',
			(n) => `=?UTF-8?Q?a?=${'=?x-unknown?Q?a?='.repeat(n)}`,
			50_000,
		],
	];

	for (const [name, make, n] of shapes) {
		test(name, () => {
			const small = fastest(make(n));
			const large = fastest(make(2 * n));
			expect(large).toBeLessThan(BOUND_MS);
			// Linear doubles; quadratic quadruples. A floor keeps a run of
			// a millisecond or two from tripping on timer noise.
			expect(large).toBeLessThan(3 * Math.max(small, 5));
		});
	}

	test('a run of 50,000 adjacent words still decodes as one', () => {
		expect(decodeEncodedWords('=?UTF-8?B?YWJj?='.repeat(50_000))).toBe(
			'abc'.repeat(50_000),
		);
		// U+00E9 split across two words reads as one character.
		expect(
			decodeEncodedWords('=?UTF-8?Q?=C3?= =?UTF-8?Q?=A9?='.repeat(3)),
		).toBe('ééé');
	});
});
