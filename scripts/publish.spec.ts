import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChangesetsOutput, changesetsGitTagEvent } from './publish';

describe('changesets/action@v2 output', () => {
	const dirs: string[] = [];
	afterAll(() =>
		Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
	);

	test('emits one NDJSON git-tag event per line', () => {
		const line = changesetsGitTagEvent('@bumail/smtp', '@bumail/smtp@1.2.3');
		expect(line.endsWith('\n')).toBe(true);
		expect(JSON.parse(line)).toEqual({
			type: 'git-tag',
			tag: '@bumail/smtp@1.2.3',
			packageName: '@bumail/smtp',
		});
	});

	test('appends events so a second publish does not clobber the first', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'changesets-output-'));
		dirs.push(dir);
		const path = join(dir, 'output.ndjson');
		await appendChangesetsOutput(path, '@bumail/mime', '@bumail/mime@1.0.3');
		await appendChangesetsOutput(path, '@bumail/smtp', '@bumail/smtp@1.0.4');
		const raw = await readFile(path, 'utf8');
		const events = raw
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(events).toEqual([
			{
				type: 'git-tag',
				tag: '@bumail/mime@1.0.3',
				packageName: '@bumail/mime',
			},
			{
				type: 'git-tag',
				tag: '@bumail/smtp@1.0.4',
				packageName: '@bumail/smtp',
			},
		]);
	});
});
