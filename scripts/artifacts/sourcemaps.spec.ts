import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import {
	LARGEST_MAPPED_SOURCE,
	readSourceMaps,
	unmappedSourceProblems,
} from './sourcemaps';

const DATA = 'x'.repeat(LARGEST_MAPPED_SOURCE + 1);

function jsMap(contents: (string | null)[]) {
	return {
		path: 'dist/index.js.map',
		map: {
			version: 3,
			sources: ['../src/index.ts', '../src/dmarc/psl-data.ts'],
			sourcesContent: contents,
			mappings: '',
		},
	};
}

const listed = {
	name: 'x',
	bumail: { unmappedSources: ['src/dmarc/psl-data.ts'] },
};

describe('unmappedSourceProblems', () => {
	test('takes a listed source whose content the map leaves out', () => {
		expect(unmappedSourceProblems(listed, [jsMap(['code', null])])).toEqual([]);
	});

	test('takes a listed source the maps do not name', () => {
		const map = {
			path: 'dist/index.js.map',
			map: { sources: ['../src/index.ts'], sourcesContent: ['code'] },
		};
		expect(unmappedSourceProblems(listed, [map])).toEqual([]);
	});

	test('refuses a listed source whose content a map still embeds', () => {
		expect(unmappedSourceProblems(listed, [jsMap(['code', 'data'])])).toEqual([
			'x: dist/index.js.map embeds src/dmarc/psl-data.ts, which bumail.unmappedSources leaves out — rebuild with the root build.ts',
		]);
	});

	test('refuses a large source once the entry is dropped from the list', () => {
		expect(
			unmappedSourceProblems({ name: 'x' }, [jsMap(['code', DATA])]),
		).toEqual([
			`x: dist/index.js.map embeds src/dmarc/psl-data.ts (${DATA.length} characters) — list it under bumail.unmappedSources if it is data, or split it`,
		]);
		expect(
			unmappedSourceProblems({ name: 'x', bumail: {} }, [
				jsMap(['code', null]),
			]),
		).toEqual([]);
	});

	test('reads paths from the map, wherever it sits in dist', () => {
		const nested = {
			path: 'dist/client/index.js.map',
			map: {
				sources: ['../../src/dmarc/psl-data.ts'],
				sourcesContent: ['data'],
			},
		};
		expect(unmappedSourceProblems(listed, [nested])).toHaveLength(1);
	});

	test('ignores a map without sourcesContent, such as a declaration map', () => {
		const declarations = {
			path: 'dist/dmarc/psl-data.d.ts.map',
			map: { sources: ['../../src/dmarc/psl-data.ts'] },
		};
		expect(unmappedSourceProblems({ name: 'x' }, [declarations])).toEqual([]);
	});
});

describe('readSourceMaps', () => {
	test('reads every .map in a tarball, by its path from the package', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'bumail-maps-spec-'));
		try {
			const map = jsMap(['code', null]).map;
			await Bun.write(join(dir, 'package/dist/index.js'), '');
			await Bun.write(
				join(dir, 'package/dist/index.js.map'),
				JSON.stringify(map),
			);
			const tgz = join(dir, 'x.tgz');
			await $`tar -czf ${tgz} -C ${dir} package`.quiet();
			const maps = await readSourceMaps(tgz, [
				'package/dist/index.js',
				'package/dist/index.js.map',
			]);
			expect(maps).toEqual([{ path: 'dist/index.js.map', map }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
