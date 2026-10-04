import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../errors';
import { type ReadConfigOptions, readConfig } from './read';

/** The least a valid configuration holds: a hostname, and ACME's two answers. */
export const ACME = `
[acme]
email = "postmaster@example.com"
acceptTerms = true
`;

export const BASE = `hostname = "mail.example.com"\n${ACME}`;

/** A fresh directory under the system's temporary one. */
export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'bumail-server-'));
}

/** `files` written into a fresh directory, by name; answers the directory. */
export function writeFiles(files: Readonly<Record<string, string>>): string {
	const dir = tempDir();
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

/** `toml` as `bumail.toml` in a fresh directory, with `files` beside it; answers its path. */
export function writeConfig(
	toml: string,
	files: Readonly<Record<string, string>> = {},
): string {
	return join(writeFiles({ 'bumail.toml': toml, ...files }), 'bumail.toml');
}

/** What `readConfig` throws for `toml`, or fails when it reads it. */
export async function errorOf(
	toml: string,
	options: Omit<ReadConfigOptions, 'path'> & {
		readonly files?: Readonly<Record<string, string>>;
	} = {},
): Promise<ServerError> {
	const { files, ...rest } = options;
	try {
		await readConfig({ env: {}, ...rest, path: writeConfig(toml, files) });
	} catch (error) {
		if (error instanceof ServerError) return error;
		throw error;
	}
	throw new Error('readConfig took a configuration it should refuse');
}

/** Each problem `readConfig` finds in `toml`, as its `path: problem` line. */
export async function problemsOf(
	toml: string,
	options: Parameters<typeof errorOf>[1] = {},
): Promise<string[]> {
	const error = await errorOf(toml, options);
	return error.problems.map(({ path, problem }) => `${path}: ${problem}`);
}
