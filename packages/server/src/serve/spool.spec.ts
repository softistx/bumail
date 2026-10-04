import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
		folder(data, 'half-made.tmp', `${process.ppid} ${hostname()}\n`);
		folder(data, `${process.ppid}-live`, `${process.ppid} ${hostname()}\n`);
		folder(data, '17-elsewhere', '17 another-machine\n');
		// A minute on: the folders with no owner are no longer being made.
		const spool = Spool.open(data, 1000, { now: Date.now() + 61_000 });
		expect(readdirSync(join(data, 'spool')).sort()).toEqual(
			[
				`${process.ppid}-live`,
				'17-elsewhere',
				spool.dir.split('/').at(-1) ?? '',
			].sort(),
		);
		expect(spool.foreign).toEqual([
			{ path: join(data, 'spool', '17-elsewhere'), host: 'another-machine' },
		]);
		spool.close();
	});

	test('keeps a folder with no owner for a minute: another server may be making it', () => {
		const data = tempDir();
		folder(data, 'no-owner');
		folder(data, 'making.tmp');
		const spool = Spool.open(data, 1000);
		expect(readdirSync(join(data, 'spool'))).toContain('no-owner');
		expect(readdirSync(join(data, 'spool'))).toContain('making.tmp');
		spool.close();
	});

	test('sweeps a folder its own pid owns: a restart as the same pid, in a container', () => {
		const data = tempDir();
		folder(data, '1-before', `1 ${hostname()}\n`);
		const spool = Spool.open(data, 1000, { pid: 1 });
		expect(readdirSync(join(data, 'spool'))).toEqual([
			spool.dir.split('/').at(-1) ?? '',
		]);
		expect(spool.dir.split('/').at(-1)).toStartWith('1-');
		spool.close();
	});

	test('writes the owner file before the folder takes its name', () => {
		const data = tempDir();
		const spool = Spool.open(data, 1000);
		expect(readdirSync(join(data, 'spool'))).toEqual([
			spool.dir.split('/').at(-1) ?? '',
		]);
		expect(readFileSync(join(spool.dir, OWNER_FILE), 'utf8')).toBe(
			`${process.pid} ${hostname()}\n`,
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
