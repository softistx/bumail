import { describe, expect, test } from 'bun:test';
import { manifestShapeProblems } from './manifest';

describe('manifestShapeProblems', () => {
	const httpyz = { name: '@bumail/mime', version: '0.4.0' };
	const binding = (peerDependencies: Record<string, string>) => ({
		name: '@bumail/smtp',
		version: '0.3.0',
		peerDependencies,
	});

	test('accepts a caret range on a sibling that includes it', () => {
		expect(
			manifestShapeProblems([httpyz, binding({ '@bumail/mime': '^0.4.0' })]),
		).toEqual([]);
	});

	test('refuses an exact pin on a sibling: two copies, two ValidationError classes', () => {
		expect(
			manifestShapeProblems([httpyz, binding({ '@bumail/mime': '0.4.0' })]),
		).toEqual([expect.stringContaining('pins a sibling exactly')]);
	});

	test('refuses a sibling range that excludes the sibling published beside it', () => {
		expect(
			manifestShapeProblems([httpyz, binding({ '@bumail/mime': '^0.3.0' })]),
		).toEqual([
			expect.stringContaining(
				'excludes @bumail/mime@0.4.0, which is being published beside it',
			),
		]);
	});

	test('refuses a package that lists itself', () => {
		expect(
			manifestShapeProblems([
				{ ...httpyz, peerDependencies: { '@bumail/mime': '.' } },
			]),
		).toEqual([expect.stringContaining('lists itself')]);
	});

	test('refuses link: and file: where a consumer installs, and not in devDependencies', () => {
		expect(
			manifestShapeProblems([
				{
					name: '@bumail/mime',
					peerDependencies: { a: 'link:../a' },
					optionalDependencies: { b: 'file:../b' },
					devDependencies: { c: 'link:../c' },
				},
			]),
		).toEqual([
			'@bumail/mime: peerDependencies.a = link:../a',
			'@bumail/mime: optionalDependencies.b = file:../b',
		]);
	});

	test('refuses any dependency: bumail packages have peers only', () => {
		expect(
			manifestShapeProblems([
				{
					name: '@bumail/mime',
					version: '1.0.0',
					dependencies: { zod: '^4.0.0' },
				},
			]),
		).toEqual([
			'@bumail/mime: declares dependencies (zod); every bumail package has none — what it needs at runtime is a peer, chosen and installed by the app',
		]);
	});
});
