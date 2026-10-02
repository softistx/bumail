/**
 * The build for every package in this workspace.
 *
 * Each package runs `bun run ../../build.ts` from its own directory. There is
 * one script rather than one per package because the packages differ only in
 * their entry points, which they declare themselves under `bumail.entrypoints`.
 *
 * Two outputs, from two tools:
 *
 *   - JavaScript, from `Bun.build` with `packages: 'external'`. A library must
 *     not bundle its dependencies: `@nxgt/openapi-httpyz` bundling its own
 *     copy of `@nxgt/httpyz` would give an app two `ValidationError` classes,
 *     and an `instanceof` that fails for one of them.
 *   - Declarations, from `tsc --emitDeclarationOnly` against
 *     `tsconfig.build.json`, which excludes the `*.spec.ts` files that
 *     `tsconfig.json` still typechecks.
 *
 * Hand-written `.d.ts` files are copied, not emitted: tsc passes them through
 * untouched, so an ambient module augmentation would otherwise never reach
 * `dist/`, and what it declares would vanish for every consumer.
 */

import { readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { $ } from 'bun';

const pkg = await Bun.file('package.json').json();
const name: string = pkg.name;
const entrypoints: string[] = pkg.bumail?.entrypoints ?? ['src/index.ts'];

// Built over the last build, not after deleting it: an editor's TypeScript
// server that reads `dist/` mid-build then still finds each declaration,
// instead of caching a sibling as a package without types until it restarts.
// What this build did not write is removed at the end.
const written = new Set<string>();

const result = await Bun.build({
	entrypoints,
	outdir: 'dist',
	root: 'src',
	target: 'node',
	format: 'esm',
	packages: 'external',
	// Shared modules become ONE chunk every entry point imports, instead of being
	// inlined into each. Without it a package with several entry points hands an
	// app two copies of its OWN classes: `@nxgt/httpyz` was defining
	// `ValidationError`, `NetworkError`, `TimeoutError`, `ReplyStatusError`,
	// `ClientError` and `UndeclaredStatusError` once in `dist/index.js` and again
	// in `dist/integration/index.js`, because `/integration` re-exports `METHODS`
	// from `create-http-client` and that pulled the whole client in behind it. An
	// `instanceof` across the two is false. Exactly the argument `packages:
	// 'external'` makes above, which already refuses to duplicate a DEPENDENCY's
	// classes and names `ValidationError` while doing it; this is the half that
	// was missing for our own.
	splitting: true,
	sourcemap: 'linked',
	naming: { entry: '[dir]/[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
});

if (!result.success) {
	console.error(`${name}: build failed`);
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

for (const output of result.outputs) {
	written.add(resolve(output.path));
	written.add(resolve(`${output.path}.map`));
}

const tsc =
	await $`tsc -p tsconfig.build.json --emitDeclarationOnly --listEmittedFiles`
		.quiet()
		.nothrow();
const listed = tsc.stdout.toString();
if (tsc.exitCode !== 0) {
	console.error(`${name}: declarations failed`);
	console.error(listed.replace(/^TSFILE: .*\n/gm, ''), tsc.stderr.toString());
	process.exit(1);
}
for (const line of listed.split('\n')) {
	if (line.startsWith('TSFILE: ')) written.add(resolve(line.slice(8).trim()));
}
const emitted = new Set(written);

// Copy hand-written declarations, preserving their path under src/.
async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else yield full;
	}
}

let copied = 0;
for await (const file of walk('src')) {
	if (!file.endsWith('.d.ts')) continue;
	const target = join('dist', relative('src', file));
	// tsc got here first, which means a `.ts` next door has the same basename
	// and this copy would replace that module's real declarations with an
	// ambient file. Refuse rather than silently truncate the public API.
	if (emitted.has(resolve(target))) {
		console.error(
			`${name}: ${file} collides with the declarations tsc emitted for ` +
				`${target}. Rename it, or move it under src/types/.`,
		);
		process.exit(1);
	}
	await $`mkdir -p ${dirname(target)}`.quiet();
	await Bun.write(target, Bun.file(file));
	written.add(resolve(target));
	copied++;
}

// What the last build wrote and this one did not: a module since moved or
// deleted, which would otherwise ship.
let pruned = 0;
for await (const file of walk('dist')) {
	if (written.has(resolve(file))) continue;
	await rm(file);
	pruned++;
}
async function removeEmpty(dir: string): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const inner = join(dir, entry.name);
		await removeEmpty(inner);
		if ((await readdir(inner)).length === 0)
			await rm(inner, { recursive: true });
	}
}
await removeEmpty('dist');

// A bin runs as a file: it keeps the `#!` line Bun.build carries over from
// its entry, and it must be executable, or `node_modules/.bin/<cmd>` fails.
const bins: Record<string, string> =
	typeof pkg.bin === 'string' ? { [name]: pkg.bin } : (pkg.bin ?? {});
for (const [command, target] of Object.entries(bins)) {
	const file = Bun.file(target);
	if (!(await file.exists()) || !(await file.text()).startsWith('#!')) {
		console.error(
			`${name}: bin ${command} points at ${target}, which is missing or has ` +
				'no #! line. Build it from an entry point that starts with one.',
		);
		process.exit(1);
	}
	await $`chmod 755 ${target}`.quiet();
}

console.log(
	`${name}: ${result.outputs.length} artifact(s)` +
		(copied ? `, ${copied} hand-written declaration(s) copied` : '') +
		(pruned ? `, ${pruned} stale file(s) removed` : ''),
);
