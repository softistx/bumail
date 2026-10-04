import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../config/config.fixtures';
import { OWNER_FILE, Spool, STALE_MS } from './spool';

const stream = (...chunks: string[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(new TextEncoder().encode(chunk));
			}
			controller.close();
		},
	});

/** A spool folder under `data`, owned by `owner` (no owner file when undefined), last touched `age` ms ago. */
function folder(data: string, name: string, owner?: string, age = 0): string {
	const path = join(data, 'spool', name);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, 'x.eml'), 'left over');
	const then = new Date(Date.now() - age);
	if (owner !== undefined) {
		writeFileSync(join(path, OWNER_FILE), owner);
		utimesSync(join(path, OWNER_FILE), then, then);
	}
	utimesSync(path, then, then);
	return path;
}

const entries = (data: string) => readdirSync(join(data, 'spool')).sort();
const nameOf = (spool: Spool) => spool.dir.split('/').at(-1) ?? '';
const STALE = STALE_MS + 1000;

describe('Spool.open', () => {
	test('sweeps a folder whose owner stopped beating, whatever its pid or host', () => {
		const data = tempDir();
		folder(
			data,
			`${process.ppid}-stale`,
			`${process.ppid} ${hostname()}\n`,
			STALE,
		);
		folder(data, '1-elsewhere', '1 another-machine\n', STALE);
		folder(data, 'no-owner', undefined, STALE);
		folder(data, 'half-made.tmp', undefined, STALE);
		const spool = Spool.open(data, 1000);
		expect(entries(data)).toEqual([nameOf(spool)]);
		expect(spool.kept).toEqual([]);
		spool.close();
	});

	test('keeps a fresh folder, from another host or with no owner file yet', () => {
		const data = tempDir();
		folder(data, '1-elsewhere', '1 another-machine\n', 60_000);
		folder(data, 'making.tmp');
		const spool = Spool.open(data, 1000);
		expect(entries(data)).toEqual(
			['1-elsewhere', 'making.tmp', nameOf(spool)].sort(),
		);
		spool.close();
	});

	test('two servers as pid 1 on one data, as two containers would be, both live', () => {
		const data = tempDir();
		const first = Spool.open(data, 1000, { pid: 1 });
		const second = Spool.open(data, 1000, { pid: 1 });
		expect(entries(data)).toEqual([nameOf(first), nameOf(second)].sort());
		first.close();
		second.close();
	});

	test('judges by the owner file, not by the folder', () => {
		const data = tempDir();
		const path = folder(data, '7-beating', `7 ${hostname()}\n`, STALE);
		// The folder untouched for long, its owner touched just now.
		const now = new Date();
		utimesSync(join(path, OWNER_FILE), now, now);
		const spool = Spool.open(data, 1000);
		expect(entries(data)).toContain('7-beating');
		spool.close();
	});

	test('keeps, and tells of, an entry whose age cannot be read', () => {
		const data = tempDir();
		mkdirSync(join(data, 'spool'), { recursive: true });
		// A stray file: its "owner file" is ENOTDIR, not ENOENT.
		writeFileSync(join(data, 'spool', 'stray'), 'x');
		const spool = Spool.open(data, 1000, { now: Date.now() + STALE });
		expect(entries(data)).toContain('stray');
		expect(spool.kept).toHaveLength(1);
		expect(spool.kept[0]?.path).toBe(join(data, 'spool', 'stray'));
		expect(spool.kept[0]?.reason).toStartWith('its age cannot be read (');
		spool.close();
	});

	test('writes the owner file before the folder takes its name, and touches it while open', async () => {
		const data = tempDir();
		const spool = Spool.open(data, 1000, { heartbeatMs: 20 });
		const owner = join(spool.dir, OWNER_FILE);
		expect(entries(data)).toEqual([nameOf(spool)]);
		expect(readFileSync(owner, 'utf8')).toBe(`${process.pid} ${hostname()}\n`);
		const old = new Date(Date.now() - STALE);
		utimesSync(owner, old, old);
		await Bun.sleep(100);
		expect(Date.now() - statSync(owner).mtimeMs).toBeLessThan(STALE_MS);
		spool.close();
		expect(entries(data)).toEqual([]);
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
