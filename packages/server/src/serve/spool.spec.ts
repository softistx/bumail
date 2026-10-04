import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../config/config.fixtures';
import { OWNER_FILE, Spool } from './spool';

const stream = (...chunks: string[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(new TextEncoder().encode(chunk));
			}
			controller.close();
		},
	});

/** A spool folder under `data`, owned by `owner` (no owner file when undefined). */
function folder(data: string, name: string, owner?: string): void {
	const path = join(data, 'spool', name);
	mkdirSync(path, { recursive: true });
	if (owner !== undefined) writeFileSync(join(path, OWNER_FILE), owner);
	writeFileSync(join(path, 'x.eml'), 'left over');
}

describe('Spool.open', () => {
	test("sweeps what a server no longer running left, never a live one's or another machine's", () => {
		const data = tempDir();
		const gone = 2 ** 22 + 12345; // past any pid this machine hands out
		folder(data, `${gone}-dead`, `${gone} ${hostname()}\n`);
		folder(data, 'no-owner');
		folder(data, '4242', undefined);
		folder(data, `${process.ppid}-live`, `${process.ppid} ${hostname()}\n`);
		folder(data, '17-elsewhere', '17 another-machine\n');
		const spool = Spool.open(data, 1000);
		expect(readdirSync(join(data, 'spool')).sort()).toEqual(
			[
				`${process.ppid}-live`,
				'17-elsewhere',
				spool.dir.split('/').at(-1) ?? '',
			].sort(),
		);
		spool.close();
	});
});

describe('Spool.write', () => {
	test('counts what waits, and gives it back on remove', async () => {
		const spool = Spool.open(tempDir(), 1000);
		const spooled = await spool.write('a', stream('A: 1\r\n\r\n', 'body'));
		if (spooled === 'full') throw new Error('full');
		expect(spool.used).toBe(spooled.size);
		expect(spool.hasRoom(1000 - spooled.size)).toBe(true);
		expect(spool.hasRoom(1001 - spooled.size)).toBe(false);
		await spooled.remove();
		expect(spool.used).toBe(0);
		spool.close();
	});

	test("answers 'full' past the budget, reads the rest, and keeps nothing", async () => {
		const spool = Spool.open(tempDir(), 10);
		const body = stream('A: 1\r\n\r\n', 'more than ten bytes', 'and more');
		expect(await spool.write('b', body)).toBe('full');
		expect(spool.used).toBe(0);
		expect(readdirSync(spool.dir)).toEqual([OWNER_FILE]);
		spool.close();
	});
});
