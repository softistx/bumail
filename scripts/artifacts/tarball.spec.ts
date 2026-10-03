import { describe, expect, test } from 'bun:test';
import {
	licenseProblems,
	missingFiles,
	TEST_CODE,
	testCodeProblems,
} from './tarball';

describe('licenseProblems', () => {
	test('wants MIT and a LICENSE in the tarball itself', () => {
		expect(
			licenseProblems({ name: 'x', license: 'MIT' }, ['package/LICENSE']),
		).toEqual([]);
		expect(licenseProblems({ name: 'x', license: 'ISC' }, [])).toEqual([
			'x: license is ISC, not MIT or MIT AND <SPDX id>',
			'x: the tarball has no LICENSE',
		]);
	});

	test('takes MIT AND another license when its text ships as LICENSE-<id>', () => {
		const manifest = { name: 'x', license: 'MIT AND MPL-2.0' };
		expect(
			licenseProblems(manifest, ['package/LICENSE', 'package/LICENSE-MPL-2.0']),
		).toEqual([]);
		expect(licenseProblems(manifest, ['package/LICENSE'])).toEqual([
			'x: license names MPL-2.0, but the tarball has no LICENSE-MPL-2.0',
		]);
	});

	test('refuses another license first, or an expression it cannot read', () => {
		expect(
			licenseProblems({ name: 'x', license: 'MPL-2.0 AND MIT' }, [
				'package/LICENSE',
			]),
		).toEqual(['x: license is MPL-2.0 AND MIT, not MIT or MIT AND <SPDX id>']);
		expect(
			licenseProblems({ name: 'x', license: 'MIT AND (GPL-3.0 OR ISC)' }, [
				'package/LICENSE',
			]),
		).toContain(
			'x: license is MIT AND (GPL-3.0 OR ISC), not MIT or MIT AND <SPDX id>',
		);
	});
});

describe('missingFiles', () => {
	const entries = [
		'package/package.json',
		'package/LICENSE',
		'package/README.md',
		'package/dist/index.js',
		'package/docs/guide/getting-started.md',
	];

	test('holds when every files entry is a file or a folder of the tarball', () => {
		expect(
			missingFiles(
				{
					name: 'x',
					files: ['dist', './docs/', 'README.md', 'package.json', 'LICENSE'],
				},
				entries,
			),
		).toEqual([]);
	});

	test('names each entry the tarball holds nothing under', () => {
		expect(
			missingFiles({ name: 'x', files: ['dist', 'doc', 'examples'] }, entries),
		).toEqual([
			'x: files lists doc, which the tarball does not hold — build it first, or drop it from files',
			'x: files lists examples, which the tarball does not hold — build it first, or drop it from files',
		]);
	});

	test('reads a folder by its name, not by a prefix of it', () => {
		expect(
			missingFiles({ name: 'x', files: ['dis'] }, ['package/dist/index.js']),
		).toEqual([
			'x: files lists dis, which the tarball does not hold — build it first, or drop it from files',
		]);
	});

	test('leaves a glob to npm, and a manifest without files alone', () => {
		expect(missingFiles({ name: 'x', files: ['*.md'] }, entries)).toEqual([]);
		expect(missingFiles({ name: 'x' }, entries)).toEqual([]);
	});
});

describe('testCodeProblems', () => {
	const x = { name: 'x' };

	test('refuses a spec, emitted or not', () => {
		expect(
			testCodeProblems(x, [
				'package/src/client/request.spec.ts',
				'package/dist/client/request.spec.d.ts',
			]),
		).toEqual([
			'x: the tarball ships test code: src/client/request.spec.ts',
			'x: the tarball ships test code: dist/client/request.spec.d.ts',
		]);
	});

	test('refuses a fixtures file with a dotted prefix, the one specs share', () => {
		expect(
			testCodeProblems(x, [
				'package/dist/client/request.fixtures.d.ts',
				'package/src/client/request.fixtures.ts',
			]),
		).toEqual([
			'x: the tarball ships test code: dist/client/request.fixtures.d.ts',
			'x: the tarball ships test code: src/client/request.fixtures.ts',
		]);
	});

	test('allows a plain fixtures file: a package may ship one on purpose', () => {
		expect(
			testCodeProblems(x, [
				'package/package.json',
				'package/dist/conformance/fixtures.d.ts',
				'package/src/conformance/fixtures.ts',
				'package/dist/index.js',
			]),
		).toEqual([]);
	});

	test('refuses a snapshot, and reads a name, not a folder', () => {
		expect(TEST_CODE.test('src/__snapshots__/a.spec.ts.snap')).toBe(true);
		expect(TEST_CODE.test('dist/specimens/index.js')).toBe(false);
		expect(TEST_CODE.test('dist/a.spec/index.js')).toBe(false);
		expect(TEST_CODE.test('dist/fixtures/index.js')).toBe(false);
	});
});
