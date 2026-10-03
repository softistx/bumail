import { describe, expect, test } from 'bun:test';
import { Cursor, MAX_DEPTH, SyntaxProblem } from './cursor';

const bytes = (text: string) => new TextEncoder().encode(text);
const one = (line: string) => new Cursor({ lines: [line], literals: [] });

describe('Cursor', () => {
	test('atoms, spaces and the end (RFC 9051 §9)', () => {
		const c = one('a001 login');
		expect(c.atom()).toBe('a001');
		c.sp();
		expect(c.atom()).toBe('login');
		expect(c.atEnd()).toBe(true);
		c.end();
	});

	test('quoted strings unescape " and \\ only', () => {
		expect(one('"a \\"b\\" \\\\c"').string()).toBe('a "b" \\c');
		expect(() => one('"a\\nb"').string()).toThrow(SyntaxProblem);
		expect(() => one('"open').string()).toThrow('Unterminated quoted string');
	});

	test('a literal is the bytes that followed its line', () => {
		const c = new Cursor({
			lines: ['A1 LOGIN {5}', ' {6}', ''],
			literals: [bytes('alice'), bytes('pa"ss\\')],
		});
		c.atom();
		c.sp();
		c.atom();
		c.sp();
		expect(c.astring()).toBe('alice');
		c.sp();
		expect(c.astring()).toBe('pa"ss\\');
		c.end();
	});

	test('a literal marker must end its line', () => {
		const c = new Cursor({ lines: ['{5} x', ''], literals: [bytes('hello')] });
		expect(() => c.string()).toThrow('A literal ends its line');
	});

	test('astring: an atom may hold "]", NIL is a string to astring', () => {
		expect(one('INBOX]').astring()).toBe('INBOX]');
		expect(one('NIL').astring()).toBe('NIL');
		expect(one('NIL').nstring()).toBeUndefined();
	});

	test('numbers are 32-bit at most', () => {
		expect(one('4294967295').number()).toBe(4294967295);
		expect(() => one('4294967296').number()).toThrow(SyntaxProblem);
		expect(() => one('99999999999999999999').number()).toThrow(SyntaxProblem);
	});

	test('lists, empty or not, nested a bounded depth', () => {
		expect(one('(\\Seen $Junk)').list((c) => c.flag())).toEqual([
			'\\Seen',
			'$Junk',
		]);
		expect(one('()').list((c) => c.atom())).toEqual([]);
		const deep = `${'('.repeat(MAX_DEPTH + 1)}${')'.repeat(MAX_DEPTH + 1)}`;
		const nest = (c: Cursor): unknown => c.list(nest);
		expect(() => nest(one(deep))).toThrow('Lists nest too deep');
	});

	test('a hundred thousand open parentheses are refused at once, not recursed into', () => {
		const started = performance.now();
		const nest = (c: Cursor): unknown => c.list(nest);
		expect(() => nest(one('('.repeat(100_000)))).toThrow(SyntaxProblem);
		expect(performance.now() - started).toBeLessThan(100);
	});

	test('a long run of backslashes in a quoted string takes linear time', () => {
		const text = `"${'\\\\'.repeat(20_000)}"`;
		const started = performance.now();
		expect(one(text).string()).toHaveLength(20_000);
		expect(performance.now() - started).toBeLessThan(200);
	});

	test('list patterns keep their wildcards', () => {
		expect(one('Archive/%').listMailbox()).toBe('Archive/%');
		expect(one('*').listMailbox()).toBe('*');
	});
});
