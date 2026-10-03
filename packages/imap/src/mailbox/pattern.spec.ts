import { describe, expect, test } from 'bun:test';
import { matcher } from './pattern';
import { DELIMITER } from './tree';

/** The former matcher, by dynamic programming: slow, and plainly right. */
function oracle(glob: string, text: string): boolean {
	let row = new Array<boolean>(text.length + 1).fill(false);
	row[0] = true;
	for (const char of glob) {
		const next = new Array<boolean>(text.length + 1).fill(false);
		if (char === '*' || char === '%') {
			next[0] = row[0] as boolean;
			for (let j = 1; j <= text.length; j++) {
				const wild = char === '*' || text[j - 1] !== DELIMITER;
				next[j] = (row[j] as boolean) || (wild && (next[j - 1] as boolean));
			}
		} else {
			for (let j = 1; j <= text.length; j++) {
				next[j] = (row[j - 1] as boolean) && text[j - 1] === char;
			}
		}
		row = next;
	}
	return row[text.length] as boolean;
}

/** A seeded generator, so a failure can be replayed. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

function word(next: () => number, alphabet: string, max: number): string {
	const length = Math.floor(next() * (max + 1));
	let out = '';
	for (let i = 0; i < length; i++)
		out += alphabet[Math.floor(next() * alphabet.length)];
	return out;
}

describe('LIST patterns (RFC 9051 §6.3.9)', () => {
	test("the RFC's examples: * crosses levels, % does not", () => {
		const names = ['INBOX', 'foo', 'foo/bar', 'foo/bar/baz', 'food'];
		const listed = (pattern: string) => names.filter(matcher(pattern));
		expect(listed('*')).toEqual(names);
		expect(listed('%')).toEqual(['INBOX', 'foo', 'food']);
		expect(listed('foo/%')).toEqual(['foo/bar']);
		expect(listed('foo*')).toEqual(['foo', 'foo/bar', 'foo/bar/baz', 'food']);
		expect(listed('foo%')).toEqual(['foo', 'food']);
		expect(listed('inbox')).toEqual(['INBOX']);
		expect(listed('%/%/%')).toEqual(['foo/bar/baz']);
	});

	test('agrees with dynamic programming on 200 000 random cases', () => {
		const next = random(9051);
		for (let i = 0; i < 200_000; i++) {
			const glob = word(next, 'ab/*%', 8);
			const text = word(next, 'ab/', 10);
			if (matcher(glob)(text) !== oracle(glob, text)) {
				throw new Error(`"${glob}" against "${text}"`);
			}
		}
	});

	test('a pattern of 1024 wildcards against a long name is quick', () => {
		const name = `${'a/'.repeat(500)}b`;
		const started = performance.now();
		for (const glob of [
			'*%'.repeat(512),
			`*${'a'.repeat(1000)}`,
			`${'%a'.repeat(511)}c`,
			`*${'a/'.repeat(300)}c*`,
		]) {
			for (let i = 0; i < 100; i++) matcher(glob)(name);
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
