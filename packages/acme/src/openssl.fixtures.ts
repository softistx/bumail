/**
 * openssl, as an outside check in specs only: what this package writes is
 * read by another implementation. The specs that use it run where
 * `openssl` is on the PATH (CI's ubuntu runners, macOS's LibreSSL) and are
 * skipped, saying so, elsewhere; `BUMAIL_TEST_OPENSSL_REQUIRED` makes a
 * missing openssl fail instead.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OPENSSL = Bun.which('openssl');

if (!OPENSSL) {
	if (process.env['BUMAIL_TEST_OPENSSL_REQUIRED']) {
		throw new Error(
			'BUMAIL_TEST_OPENSSL_REQUIRED is set, and openssl is not on the PATH',
		);
	}
	console.warn('openssl is not on the PATH: its cross-checks are skipped');
}

export interface OpensslResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs openssl with `files` written to a temporary directory, named in `args` as `{name}`. */
export async function openssl(
	args: string[],
	files: Record<string, string> = {},
): Promise<OpensslResult> {
	if (!OPENSSL) throw new Error('openssl is not on the PATH');
	const dir = await mkdtemp(join(tmpdir(), 'bumail-acme-'));
	try {
		for (const [name, text] of Object.entries(files)) {
			await Bun.write(join(dir, name), text);
		}
		const proc = Bun.spawn(
			[
				OPENSSL,
				...args.map((arg) =>
					arg.replace(/\{(\w[\w.-]*)\}/g, (_, name) => join(dir, name)),
				),
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
