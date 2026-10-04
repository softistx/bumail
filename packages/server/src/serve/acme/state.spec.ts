import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../config/config.fixtures';
import { AcmeState } from './state';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('AcmeState', () => {
	test('writes the account key and the pair in a directory of mode 0700, the files 0600', async () => {
		const dir = join(tempDir(), 'acme');
		const state = new AcmeState(dir);
		expect(state.readAccountKey()).toBeUndefined();
		expect(state.readPair()).toBeUndefined();
		await state.writeAccountKey('account');
		await state.writePair({ cert: 'cert', key: 'key' });
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

	test('mode 0600 whatever the umask, and over a file that was looser', async () => {
		const dir = tempDir();
		writeFileSync(join(dir, 'key.pem'), 'old', { mode: 0o644 });
		const before = process.umask(0);
		try {
			await new AcmeState(dir).writePair({ cert: 'new', key: 'new' });
		} finally {
			process.umask(before);
		}
		expect(mode(join(dir, 'key.pem'))).toBe(0o600);
		expect(readFileSync(join(dir, 'key.pem'), 'utf8')).toBe('new');
	});

	test('replaces by rename: a reader sees the old text or the new, and no temporary file is left', async () => {
		const dir = tempDir();
		const state = new AcmeState(dir);
		await state.writePair({ cert: 'one', key: 'one' });
		const big = 'x'.repeat(1_000_000);
		const seen = new Set<string>();
		let writing = true;
		const reader = (async () => {
			while (writing) {
				const pair = state.readPair();
				if (pair)
					seen.add(
						pair.cert.length === 3
							? 'one'
							: pair.cert.length === big.length
								? 'big'
								: 'torn',
					);
				await Bun.sleep(0);
			}
		})();
		await state.writePair({ cert: big, key: big });
		writing = false;
		await reader;
		expect(seen.has('torn')).toBe(false);
		expect(readdirSync(dir).sort()).toEqual(['cert.pem', 'key.pem']);
	});

	test('a file it cannot read is an error, not "no certificate"', () => {
		const dir = tempDir();
		mkdirSync(join(dir, 'cert.pem'));
		writeFileSync(join(dir, 'key.pem'), 'k');
		expect(() => new AcmeState(dir).readPair()).toThrow();
	});
});
