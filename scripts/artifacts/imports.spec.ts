import { describe, expect, test } from 'bun:test';
import { packageOf, undeclaredImports } from './imports';

describe('packageOf', () => {
	test('reads a scoped name and a plain one, without the subpath', () => {
		expect(packageOf('@bumail/store/memory')).toBe('@bumail/store');
		expect(packageOf('@bumail/store')).toBe('@bumail/store');
		expect(packageOf('lodash/fp')).toBe('lodash');
	});
});

describe('undeclaredImports', () => {
	const smtp = { name: '@bumail/smtp' };

	test('refuses a sibling the manifest lists only as a devDependency', () => {
		const manifest = {
			...smtp,
			devDependencies: { '@bumail/store': 'workspace:^' },
		};
		expect(
			undeclaredImports(manifest, [
				[
					'dist/index.js',
					'import { MemoryMailStore } from "@bumail/store";\nexport { MemoryMailStore };',
				],
			]),
		).toEqual([['dist/index.js', '@bumail/store']]);
	});

	test('passes the runtime, relative files, chunks and the package itself', () => {
		expect(
			undeclaredImports(smtp, [
				[
					'dist/index.js',
					[
						'import { listen } from "bun";',
						'import { Database } from "bun:sqlite";',
						'import { resolveMx } from "node:dns";',
						'import { reply } from "./chunks/reply-abc.js";',
						'import { x } from "@bumail/smtp/client";',
						'export { listen, Database, resolveMx, reply, x };',
					].join('\n'),
				],
			]),
		).toEqual([]);
	});

	test('passes a peer, a dependency and an optional dependency', () => {
		expect(
			undeclaredImports(
				{
					...smtp,
					peerDependencies: { '@bumail/mime': '^0.1.0' },
					dependencies: { a: '1' },
					optionalDependencies: { b: '1' },
				},
				[
					[
						'dist/index.js',
						'import "@bumail/mime/build";\nimport "a";\nimport "b/sub";',
					],
				],
			),
		).toEqual([]);
	});

	test('catches a dynamic import and a re-export too', () => {
		expect(
			undeclaredImports(smtp, [
				['dist/a.js', 'export * from "@bumail/store";'],
				['dist/b.js', 'export const load = () => import("@bumail/queue");'],
			]),
		).toEqual([
			['dist/a.js', '@bumail/store'],
			['dist/b.js', '@bumail/queue'],
		]);
	});
});
