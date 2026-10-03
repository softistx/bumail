import { describe, expect, test } from 'bun:test';
import { declarationSpecifiers } from './declarations';

describe('declarationSpecifiers', () => {
	test('reads every form tsc emits', () => {
		expect(
			declarationSpecifiers(
				[
					'/// <reference types="a" />',
					"import type { B } from 'b';",
					'import { C } from "c";',
					"import 'd';",
					"export * from 'e';",
					"export * as f from 'f';",
					"export type { G } from 'g';",
					"export { H } from './h';",
					"export type I = import('i').I;",
					"import J = require('j');",
				].join('\n'),
			).sort(),
		).toEqual(['./h', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j']);
	});

	test('a specifier inside a JSDoc comment or a string literal type is no import', () => {
		expect(
			declarationSpecifiers(
				[
					'/**',
					" * @example import { MemoryMailStore } from '@bumail/store';",
					" * const x = await import('@bumail/queue');",
					' */',
					"// import '@bumail/dns';",
					'export type Example = "import { A } from \'not-a-module\'";',
					"export declare const url: 'http://example.com/x';",
					"export type { Reply } from './protocol/reply';",
				].join('\n'),
			),
		).toEqual(['./protocol/reply']);
	});

	test('an escaped quote does not end a string early', () => {
		expect(
			declarationSpecifiers(
				"export type Q = 'it\\'s from \\'x\\'';\nimport type { Y } from 'y';",
			),
		).toEqual(['y']);
	});
});
