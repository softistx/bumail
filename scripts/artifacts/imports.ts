import { join } from 'node:path';
import type { Pkg } from './packages';

/** The fields whose names a built import may reach: what a consumer installs. */
const RUNTIME_FIELDS = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

/** The package a bare specifier names: `@scope/name` or `name`, no subpath. */
export function packageOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@')
		? parts.slice(0, 2).join('/')
		: (parts[0] ?? specifier);
}

/** Whether a specifier is the runtime's own, never a package. */
function isRuntime(specifier: string): boolean {
	return (
		specifier === 'bun' ||
		specifier.startsWith('bun:') ||
		specifier.startsWith('node:')
	);
}

/**
 * Every import in the given bundles that names a package the manifest does
 * not declare, from the bundles' paths and texts. Relative imports, the
 * runtime's own (`bun`, `bun:*`, `node:*`) and the package itself pass; so
 * does anything in `dependencies`, `peerDependencies` or
 * `optionalDependencies`. A devDependency never does: no consumer installs
 * it. Pure, so it has specs.
 */
export function undeclaredImports(
	manifest: { name: string } & Partial<
		Record<(typeof RUNTIME_FIELDS)[number], Record<string, string>>
	>,
	bundles: Iterable<readonly [rel: string, text: string]>,
): [file: string, specifier: string][] {
	const declared = new Set<string>([manifest.name]);
	for (const field of RUNTIME_FIELDS) {
		for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
	}
	const transpiler = new Bun.Transpiler({ loader: 'js' });
	const found: [string, string][] = [];
	for (const [rel, text] of bundles) {
		for (const { path } of transpiler.scanImports(text)) {
			if (path.startsWith('.') || path.startsWith('/') || isRuntime(path)) {
				continue;
			}
			if (!declared.has(packageOf(path))) found.push([rel, path]);
		}
	}
	return found;
}

/**
 * Every built import names something the manifest declares, checked on the
 * installed tarballs; false if any package imports what it does not declare.
 *
 * The install below holds every package of this repository side by side, so
 * a package that imports a sibling it lists only as a devDependency — the
 * smtp delivery spec uses `@bumail/store` that way — still loads there. A
 * consumer who installs that package alone gets "Cannot find package". Only
 * reading the imports catches it; loading cannot. bumail's addition to the
 * scripts copied from alxia and nxgt-http.
 */
export async function importsDeclared(
	workdir: string,
	packages: readonly Pkg[],
): Promise<boolean> {
	console.log('\nChecking every built import is declared…\n');
	let undeclared = 0;
	for (const pkg of packages) {
		const root = join(workdir, 'node_modules', pkg.name);
		const manifest = await Bun.file(join(root, 'package.json')).json();
		const bundles: [string, string][] = [];
		for await (const rel of new Bun.Glob('dist/**/*.js').scan({
			cwd: root,
			onlyFiles: true,
		})) {
			bundles.push([rel, await Bun.file(join(root, rel)).text()]);
		}
		const found = undeclaredImports(manifest, bundles);
		if (found.length === 0) {
			console.log(`  ok      ${pkg.name}`);
			continue;
		}
		undeclared++;
		for (const [file, specifier] of found) {
			console.log(`  FAIL    ${pkg.name}: ${file} imports "${specifier}"`);
		}
	}
	if (undeclared > 0) {
		console.error(
			`\n${undeclared} package(s) import a package their manifest does not ` +
				'declare. It loads\nhere only because every sibling is installed ' +
				'beside it; a consumer gets\n"Cannot find package". Declare it as a ' +
				'peer (and devDependency), or stop\nimporting it. See AGENTS.md.',
		);
		return false;
	}
	console.log(
		`\nEvery built import is declared in all ${packages.length} packages.`,
	);
	return true;
}
