import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** The source file a relative specifier names, as Bun resolves it. */
function resolveSource(from: string, specifier: string): string {
	const base = join(dirname(from), specifier);
	for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`${from}: cannot resolve "${specifier}"`);
}

/** Every file and bare specifier an entry point reaches at runtime: type-only imports are dropped. */
async function reached(entry: string) {
	const files = new Set<string>();
	const outside = new Set<string>();
	const pending = [entry];
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (files.has(file)) continue;
		files.add(file);
		const text = await Bun.file(file).text();
		for (const { path } of transpiler.scanImports(text)) {
			if (path.startsWith('.')) pending.push(resolveSource(file, path));
			else outside.add(path);
		}
	}
	return { files: [...files], outside };
}

const src = import.meta.dir;

describe('entry points', () => {
	test('the main entry never reaches the client: the server loads without it', async () => {
		const { files } = await reached(join(src, 'index.ts'));
		expect(files.filter((file) => file.includes('/client/'))).toEqual([]);
	});

	test('neither entry imports @bumail/dns at runtime: it is an optional peer, for the Resolver type', async () => {
		for (const entry of ['index.ts', 'client/index.ts']) {
			const { outside } = await reached(join(src, entry));
			expect(
				[...outside].filter((name) => name.startsWith('@bumail/')),
			).toEqual([]);
		}
	});
});
