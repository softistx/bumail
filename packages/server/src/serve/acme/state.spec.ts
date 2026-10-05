import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../config/config.fixtures';
import { AcmeState } from './state';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('AcmeState', () => {
	test('writes the account key and the pair in a directory of mode 0700, the files 0600', () => {
		const dir = join(tempDir(), 'acme');
		const state = new AcmeState(dir);
		expect(state.readAccountKey()).toBeUndefined();
		expect(state.readPair()).toBeUndefined();
		state.writeAccountKey('account');
		state.writePair({ cert: 'cert', key: 'key' });
		expect(mode(dir)).toBe(0o700);
		expect(readdirSync(dir).sort()).toEqual([
			'account.key',
			'cert.pem',
			'key.pem',
		]);
		for (const file of readdirSync(dir))
			expect(mode(join(dir, file))).toBe(0o600);
		expect(state.readAccountKey()).toBe('account');
		expect(state.readPair()).toEqual({ cert: 'cert', key: 'key' });
	});

	test('a directory that exists is left as its owner set it', () => {
		const dir = tempDir();
		mkdirSync(join(dir, 'shared'), { mode: 0o755 });
		new AcmeState(join(dir, 'shared')).writePair({ cert: 'c', key: 'k' });
		expect(mode(join(dir, 'shared'))).toBe(0o755);
	});

	test('mode 0600 whatever the umask, and over a file that was looser', () => {
		const dir = tempDir();
		writeFileSync(join(dir, 'key.pem'), 'old', { mode: 0o644 });
		const before = process.umask(0);
		try {
			new AcmeState(dir).writePair({ cert: 'new', key: 'new' });
		} finally {
			process.umask(before);
		}
		expect(mode(join(dir, 'key.pem'))).toBe(0o600);
		expect(readFileSync(join(dir, 'key.pem'), 'utf8')).toBe('new');
	});

	test('keeps the pair it replaces as the previous one, and no temporary file', () => {
		const dir = tempDir();
		const state = new AcmeState(dir);
		state.writePair({ cert: 'one', key: 'one' });
		expect(state.readPrevious()).toBeUndefined();
		state.writePair({ cert: 'two', key: 'two' });
		expect(state.readPair()).toEqual({ cert: 'two', key: 'two' });
		expect(state.readPrevious()).toEqual({ cert: 'one', key: 'one' });
		expect(readdirSync(dir).sort()).toEqual([
			'cert.pem',
			'cert.prev.pem',
			'key.pem',
			'key.prev.pem',
		]);
		state.restorePrevious();
		expect(state.readPair()).toEqual({ cert: 'one', key: 'one' });
	});

	test('a planted symbolic link at the temporary name is not followed: the victim is untouched and the write fails', () => {
		const dir = tempDir();
		const victim = join(tempDir(), 'victim');
		writeFileSync(victim, 'precious', { mode: 0o644 });
		symlinkSync(victim, join(dir, 'key.pem.fixed.tmp'));
		const state = new AcmeState(dir, () => 'fixed');
		expect(() => state.writePair({ cert: 'c', key: 'PRIVATE KEY' })).toThrow();
		expect(readFileSync(victim, 'utf8')).toBe('precious');
		expect(mode(victim)).toBe(0o644);
	});

	test('a link at the final name is replaced, not written through', () => {
		const dir = tempDir();
		const victim = join(tempDir(), 'victim');
		writeFileSync(victim, 'precious');
		symlinkSync(victim, join(dir, 'key.pem'));
		new AcmeState(dir).writePair({ cert: 'c', key: 'PRIVATE KEY' });
		expect(readFileSync(victim, 'utf8')).toBe('precious');
		expect(readFileSync(join(dir, 'key.pem'), 'utf8')).toBe('PRIVATE KEY');
	});

	test('a file it cannot read is an error, not "no certificate"', () => {
		const dir = tempDir();
		mkdirSync(join(dir, 'cert.pem'));
		writeFileSync(join(dir, 'key.pem'), 'k');
		expect(() => new AcmeState(dir).readPair()).toThrow();
	});
});
