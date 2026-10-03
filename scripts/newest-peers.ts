#!/usr/bin/env bun
/**
 * Rewrites the workspace to build against the newest version of each peer
 * the packages accept: for a peer range with alternatives, such as
 * `typescript: ^6.0.3 || ^7.0.0`, the last one — alternatives are written
 * oldest first.
 *
 * The repository's own toolchain is the lockfile's: the first alternative of
 * each range, so everything CI normally runs proves only that end of it.
 * CI's "Newest peers" job runs this, installs, then builds, typechecks,
 * tests and verifies the artifacts: the other end. The ranges come from the
 * packages' own manifests, so widening one is all it takes for this to test
 * it — and a range it could not test fails the run, rather than pass it.
 *
 * It edits the root `package.json` (`devDependencies` and `overrides`) and
 * each package's `devDependencies` in place: run it on a throwaway checkout,
 * never commit what it writes.
 *
 *   bun scripts/newest-peers.ts
 */
import { join } from 'node:path';
import { ROOT } from './artifacts/packages';

export type Manifest = Record<string, unknown> & {
	name?: string;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	overrides?: Record<string, string>;
};

/** The last alternative of a range; `undefined` when it has only one. */
export function newest(range: string): string | undefined {
	const alternatives = range.split('||').map((part) => part.trim());
	return alternatives.length > 1 ? alternatives.at(-1) : undefined;
}

export interface Rewrite {
	readonly root: Manifest;
	readonly packages: ReadonlyMap<string, Manifest>;
	/** One line per version pinned: `<where> <name>@<version>`. */
	readonly pinned: readonly string[];
}

/**
 * The manifests with every peer that has alternatives pinned to its newest:
 * in the package's `devDependencies` when it lists the peer, else in the
 * root's, and in the root's `overrides` wherever one names it. Pure: the
 * caller writes the result, or nothing when this throws.
 */
export function rewrite(
	root: Manifest,
	packages: ReadonlyMap<string, Manifest>,
): Rewrite {
	const nextRoot: Manifest = structuredClone(root);
	const next = new Map<string, Manifest>();
	const pinned: string[] = [];
	const atRoot = new Map<string, string>();

	for (const [path, manifest] of packages) {
		const copy: Manifest = structuredClone(manifest);
		for (const [name, range] of Object.entries(copy.peerDependencies ?? {})) {
			const version = newest(range);
			if (version === undefined) continue;
			if (copy.devDependencies?.[name] !== undefined) {
				copy.devDependencies[name] = version;
				pinned.push(`${String(copy.name).padEnd(24)} ${name}@${version}`);
			} else if (nextRoot.devDependencies?.[name] === undefined) {
				throw new Error(
					`${copy.name} accepts ${name} ${range}, but neither it nor the root installs ${name}: add it to ${copy.name}'s devDependencies.`,
				);
			}
			const seen = atRoot.get(name);
			if (seen !== undefined && seen !== version) {
				throw new Error(
					`The packages disagree on the newest ${name}: ${seen} and ${version}. Align their peer ranges.`,
				);
			}
			atRoot.set(name, version);
		}
		next.set(path, copy);
	}

	for (const [name, version] of atRoot) {
		const where: string[] = [];
		if (nextRoot.devDependencies?.[name] !== undefined) {
			nextRoot.devDependencies[name] = version;
			where.push('devDependencies');
		}
		if (nextRoot.overrides?.[name] !== undefined) {
			nextRoot.overrides[name] = version;
			where.push('overrides');
		}
		if (where.length > 0) {
			pinned.push(
				`${`(root ${where.join(', ')})`.padEnd(24)} ${name}@${version}`,
			);
		}
	}
	if (pinned.length === 0) {
		throw new Error('No peer range has an alternative: nothing newer to test.');
	}
	return { root: nextRoot, packages: next, pinned };
}

async function write(path: string, manifest: Manifest): Promise<void> {
	await Bun.write(path, `${JSON.stringify(manifest, null, '\t')}\n`);
}

if (import.meta.main) {
	const rootPath = join(ROOT, 'package.json');
	const packages = new Map<string, Manifest>();
	for (const file of new Bun.Glob('packages/*/package.json').scanSync(ROOT)) {
		const path = join(ROOT, file);
		packages.set(path, (await Bun.file(path).json()) as Manifest);
	}
	let result: Rewrite;
	try {
		result = rewrite((await Bun.file(rootPath).json()) as Manifest, packages);
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
	await write(rootPath, result.root);
	for (const [path, manifest] of result.packages) await write(path, manifest);
	for (const line of result.pinned) console.log(`  pinned   ${line}`);
}
