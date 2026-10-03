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
						'import { readFileSync } from "fs";',
						'import { reply } from "./chunks/reply-abc.js";',
						'import { x } from "@bumail/smtp/client";',
						'export { listen, Database, resolveMx, readFileSync, reply, x };',
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

	test('catches a dynamic import, a require and a re-export too', () => {
		expect(
			undeclaredImports(smtp, [
				['dist/a.js', 'export * from "@bumail/store";'],
				['dist/b.js', 'export const load = () => import("@bumail/queue");'],
				['dist/c.js', 'module.exports = require("@bumail/dns");'],
			]),
		).toEqual([
			['dist/a.js', '@bumail/store'],
			['dist/b.js', '@bumail/queue'],
			['dist/c.js', '@bumail/dns'],
		]);
	});

	test('catches the type-only imports a declaration file holds', () => {
		expect(
			undeclaredImports(smtp, [
				['dist/a.d.ts', "export type { MailStore } from '@bumail/store';"],
				[
					'dist/b.d.ts',
					"import type { Job } from '@bumail/queue';\nexport type J = Job;",
				],
				['dist/c.d.ts', "export type R = import('@bumail/dns').Resolver;"],
				['dist/d.d.ts', "export type { Reply } from './protocol/reply';"],
				['dist/e.d.ts', '/// <reference types="@bumail/jmap" />'],
				[
					'dist/f.d.ts',
					"import type { Server } from 'bun';\nexport type S = Server;",
				],
			]),
		).toEqual([
			['dist/a.d.ts', '@bumail/store'],
			['dist/b.d.ts', '@bumail/queue'],
			['dist/c.d.ts', '@bumail/dns'],
			['dist/e.d.ts', '@bumail/jmap'],
		]);
	});
});
