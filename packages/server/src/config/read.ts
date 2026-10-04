import { dirname, resolve } from 'node:path';
import { invalidConfig } from '../errors';
import { checkConfig } from './check';
import { Checker, isTable } from './checker';
import { type Env, readOverrides } from './env';
import { readText } from './files';
import type { ServerConfig } from './types';

/** Where the configuration is read when neither `path` nor `BUMAIL_CONFIG` says. */
export const DEFAULT_CONFIG_PATH = '/data/bumail.toml';

export interface ReadConfigOptions {
	/** The file; `--config` on the command line. Default `BUMAIL_CONFIG`, then `/data/bumail.toml`. */
	readonly path?: string;
	/** Where `BUMAIL_*` overrides come from. Default `process.env`. */
	readonly env?: Env;
	/** What the certificate's validity is checked against. Default now. */
	readonly now?: Date;
}

/** The file to read: `path`, else `BUMAIL_CONFIG`, else `/data/bumail.toml`. */
export function configPath(options: ReadConfigOptions = {}): string {
	const env = options.env ?? process.env;
	return options.path ?? (env['BUMAIL_CONFIG'] || DEFAULT_CONFIG_PATH);
}

/**
 * Reads the TOML configuration, applies the environment's overrides
 * (`BUMAIL_HOSTNAME`, `BUMAIL_STORE_URL`, `BUMAIL_QUEUE_URL`,
 * `BUMAIL_SMARTHOST_PASSWORD`, each also as `*_FILE`), checks it whole and
 * fills in its defaults. Throws `ServerError('INVALID_CONFIG')` listing
 * every problem found; no problem repeats a URL or a secret.
 */
export async function readConfig(
	options: ReadConfigOptions = {},
): Promise<ServerConfig> {
	const env = options.env ?? process.env;
	const file = configPath(options);
	const checker = new Checker();
	const overrides = readOverrides(checker, env);

	const text = readText(checker, file, '(file)');
	if (text === undefined) throw invalidConfig(file, checker.problems);

	let raw: unknown;
	try {
		raw = Bun.TOML.parse(text);
	} catch (error) {
		checker.add('(file)', `is not TOML: ${tomlReason(error)}`);
		throw invalidConfig(file, checker.problems);
	}
	return checkConfig(checker, isTable(raw) ? raw : {}, {
		file,
		dir: dirname(resolve(file)),
		overrides,
		now: options.now ?? new Date(),
		env,
	});
}

/**
 * Bun's reason, with what it quotes masked, in double or single quotes:
 * `Strings must be quoted: "hunter2"` repeats the unquoted value, which
 * may be a password.
 */
function tomlReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/^TOML Parse error: /, '')
		.replace(/"[^"]*"/g, '"…"')
		.replace(/'[^']*'/g, "'…'");
}
