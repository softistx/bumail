import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entry } from '../contract/fixtures/setup.fixtures';
import { temporaryStores } from './directories.fixtures';

const { directory, open } = temporaryStores();

const ITEMS = 60;
const PROCESSES = 4;

describe('SqliteQueueStore across processes', () => {
	test('several processes on one database claim every item exactly once', async () => {
		const at = directory();
		const store = open(at);
		const ids = new Set<string>();
		for (let i = 0; i < ITEMS; i++) {
			ids.add((await store.add(entry({ createdAt: Date.now() - 1000 }))).id);
		}
		const workers = Array.from({ length: PROCESSES }, (_, n) =>
			Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, 'claimer.fixtures.ts'),
					at,
					`p${n}`,
				],
				{ stdout: 'pipe', stderr: 'inherit' },
			),
		);
		// Every process is open before any claims: they race for the same rows.
		await Bun.sleep(200);
		writeFileSync(join(at, 'go'), '');
		const outputs = await Promise.all(
			workers.map(async (worker) => {
				const text = await new Response(worker.stdout).text();
				expect(await worker.exited).toBe(0);
				return JSON.parse(text) as string[];
			}),
		);
		const claimed = outputs.flat();
		expect(claimed).toHaveLength(ITEMS);
		expect(new Set(claimed)).toEqual(ids);
		const owners = new Set(
			(await store.list({ limit: ITEMS })).map((i) => i.lease?.owner),
		);
		expect(owners.has(undefined)).toBe(false);
	}, 30_000);
});
