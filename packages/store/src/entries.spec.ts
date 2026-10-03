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

/** Every bare or runtime specifier an entry point reaches, through its relative imports. */
async function reached(entry: string): Promise<Set<string>> {
	const seen = new Set<string>();
	const outside = new Set<string>();
	const pending = [entry];
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		const text = await Bun.file(file).text();
		for (const { path } of transpiler.scanImports(text)) {
			if (path.startsWith('.')) pending.push(resolveSource(file, path));
			else outside.add(path);
		}
	}
	return outside;
}

const src = import.meta.dir;

describe('entry points', () => {
	test('the main entry never reaches bun:sqlite: the memory store loads without it', async () => {
		expect(await reached(join(src, 'index.ts'))).not.toContain('bun:sqlite');
	});

	test('@bumail/store/sqlite does', async () => {
		expect(await reached(join(src, 'sqlite', 'index.ts'))).toContain(
			'bun:sqlite',
		);
	});
});
