import type { Checker } from './checker';
import { readText } from './files';

/** The environment, as `process.env` gives it. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What the environment may set: URLs and secrets only, each over the file. */
export const OVERRIDES = {
	hostname: 'BUMAIL_HOSTNAME',
	storeUrl: 'BUMAIL_STORE_URL',
	queueUrl: 'BUMAIL_QUEUE_URL',
	smarthostPassword: 'BUMAIL_SMARTHOST_PASSWORD',
} as const;

export type Overrides = {
	-readonly [K in keyof typeof OVERRIDES]?: {
		/** The value. */
		readonly value: string;
		/** The variable it came from, `BUMAIL_STORE_URL` or `BUMAIL_STORE_URL_FILE`. */
		readonly from: string;
	};
};

/**
 * Every override the environment sets: `NAME`, or the content of the file
 * `NAME_FILE` names (one trailing line break dropped), never both. An
 * empty variable is unset, as Docker leaves one it was given without a
 * value.
 */
export function readOverrides(checker: Checker, env: Env): Overrides {
	const overrides: Overrides = {};
	for (const [field, name] of Object.entries(OVERRIDES) as [
		keyof typeof OVERRIDES,
		string,
	][]) {
		const direct = env[name] || undefined;
		const fileName = `${name}_FILE`;
		const file = env[fileName] || undefined;
		if (direct !== undefined && file !== undefined) {
			checker.add(name, `is set with ${fileName}; set one of them`);
			continue;
		}
		if (direct !== undefined) {
			overrides[field] = { value: direct, from: name };
			continue;
		}
		if (file === undefined) continue;
		const text = readText(checker, file, fileName);
		if (text === undefined) continue;
		const value = text.replace(/\r?\n$/, '');
		if (value === '') {
			checker.add(fileName, 'names an empty file');
			continue;
		}
		overrides[field] = { value, from: fileName };
	}
	return overrides;
}
