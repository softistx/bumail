import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { $ } from 'bun';

/** One source map in a tarball, its path from the package's root. */
export type SourceMapFile = { path: string; map: unknown };

/**
 * The largest source a packed map may embed without being listed under
 * `bumail.unmappedSources`. The largest module of code is under 8 KiB; the
 * Public Suffix List snapshot is over 75 KiB. A source past this is taken
 * for data, which the bundle already holds: listing it keeps it out of
 * the map, and splitting it is the answer for code that grew this large.
 */
export const LARGEST_MAPPED_SOURCE = 32 * 1024;

/** Every `.map` file a tarball holds, parsed. */
export async function readSourceMaps(
	tgz: string,
	entries: readonly string[],
): Promise<SourceMapFile[]> {
	const paths = entries.filter((path) => path.endsWith('.map'));
	if (paths.length === 0) return [];
	const dir = await mkdtemp(join(tmpdir(), 'bumail-maps-'));
	try {
		await $`tar -xzf ${tgz} -C ${dir} ${paths}`.quiet();
		return await Promise.all(
			paths.map(async (path) => ({
				path: path.replace(/^package\//, ''),
				map: JSON.parse(await Bun.file(join(dir, path)).text()),
			})),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Each source a map embeds, as a path from the package's root. */
function embeddedSources(
	file: SourceMapFile,
): { source: string; length: number }[] {
	const map = file.map as { sources?: unknown; sourcesContent?: unknown };
	if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
		return [];
	}
	const contents = map.sourcesContent;
	return map.sources.flatMap((source: unknown, i: number) => {
		const content = contents[i];
		if (typeof source !== 'string' || typeof content !== 'string') return [];
		const path = posix.normalize(posix.join(posix.dirname(file.path), source));
		return [{ source: path, length: content.length }];
	});
}

/**
 * A module listed under `bumail.unmappedSources` whose content a packed map
 * still embeds, and a source past `LARGEST_MAPPED_SOURCE` that is not listed.
 * The first is a build that ignored the list; the second, the list losing
 * the entry: either way the data would ship twice, once in the `.js` and
 * once in its `.map`, and nothing else would say so.
 */
export function unmappedSourceProblems(
	manifest: Record<string, unknown>,
	maps: readonly SourceMapFile[],
): string[] {
	const bumail = (manifest.bumail ?? {}) as { unmappedSources?: unknown };
	const unmapped = new Set(
		(Array.isArray(bumail.unmappedSources) ? bumail.unmappedSources : [])
			.filter((path): path is string => typeof path === 'string')
			.map((path) => posix.normalize(path)),
	);
	const problems: string[] = [];
	for (const file of maps) {
		for (const { source, length } of embeddedSources(file)) {
			if (unmapped.has(source)) {
				problems.push(
					`${manifest.name}: ${file.path} embeds ${source}, which bumail.unmappedSources leaves out — rebuild with the root build.ts`,
				);
			} else if (length > LARGEST_MAPPED_SOURCE) {
				problems.push(
					`${manifest.name}: ${file.path} embeds ${source} (${length} characters) — list it under bumail.unmappedSources if it is data, or split it`,
				);
			}
		}
	}
	return problems;
}
