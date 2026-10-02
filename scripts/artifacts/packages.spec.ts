import { describe, expect, test } from 'bun:test';
import { subpathsOf } from './packages';

describe('subpathsOf', () => {
	test('names every exported subpath, and not package.json', () => {
		expect(
			subpathsOf('@bumail/mime', {
				'.': {},
				'./integration': {},
				'./package.json': './package.json',
			}),
		).toEqual(['@bumail/mime', '@bumail/mime/integration']);
	});
});
