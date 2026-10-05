import { expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, prepareAcme } from './acme.fixtures';

const MAIN = join(import.meta.dir, '..', 'main.ts');

test('bumail serve with no certificate yet stops on SIGTERM while it waits, exiting 0', async () => {
	const { file } = await prepareAcme({
		directory: 'https://localhost:1/dir',
	});
	const http = freePort();
	appendFileSync(
		file,
		`\n[ports]\nhttp = ${http}\nmx = ${freePort()}\nsubmissions = ${freePort()}\nsubmission = ${freePort()}\nimaps = ${freePort()}\nhttps = ${freePort()}\nhealth = ${freePort()}\n`,
	);
	const proc = Bun.spawn([process.execPath, MAIN, 'serve', '--config', file], {
		env: { PATH: process.env['PATH'] ?? '' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const decoder = new TextDecoder();
	const reader = proc.stdout.getReader();
	let out = '';
	const until = async (text: string) => {
		const end = Date.now() + 10_000;
		while (!out.includes(text) && Date.now() < end) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value);
		}
		if (!out.includes(text)) {
			proc.kill('SIGKILL');
			throw new Error(`no "${text}" in:\n${out}`);
		}
	};
	await until('tls: obtaining a certificate failed (try 1 of 5)');
	expect(out).toContain(
		'tls: waiting for a certificate from https://localhost:1/dir',
	);
	// A SIGHUP while it waits is said and ignored; the wait goes on.
	proc.kill('SIGHUP');
	await until(
		'bumail: SIGHUP, the server has not started yet; nothing to reload',
	);
	await Bun.sleep(100);
	expect(proc.killed).toBe(false);
	expect(proc.exitCode).toBeNull();
	proc.kill('SIGTERM');
	expect(await proc.exited).toBe(0);
	out += decoder.decode((await reader.read()).value ?? new Uint8Array());
	expect(out).toContain('bumail: SIGTERM, stopping');
});
