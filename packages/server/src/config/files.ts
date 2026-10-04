import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Checker } from './checker';

/** The text of `file`, or `undefined` with `cannot be read (<code>)` recorded at `path`. */
export function readText(
	checker: Checker,
	file: string,
	path: string,
): string | undefined {
	try {
		return readFileSync(file, 'utf8');
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		checker.add(
			path,
			`cannot be read (${typeof code === 'string' ? code : 'error'})`,
		);
		return undefined;
	}
}

/** `file` as given when absolute, else from `dir`: the configuration file's own directory. */
export function fromDir(dir: string, file: string): string {
	return isAbsolute(file) ? file : resolve(dir, file);
}
