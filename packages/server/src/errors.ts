/**
 * What went wrong, as a code to branch on:
 *
 * - `INVALID_CONFIG`: the configuration cannot be read, is not TOML, or
 *   breaks a rule. The message names the file, then one `path: problem`
 *   line per problem, each also in `problems`.
 * - `USAGE`: the `bumail` command was given an argument it does not take.
 */
export type ServerErrorCode = 'INVALID_CONFIG' | 'USAGE';

/** One thing wrong with a configuration: where, and what. */
export interface ConfigProblem {
	/** The key, dotted from the top (`ports.mx`), or the environment variable (`BUMAIL_STORE_URL`). */
	readonly path: string;
	/** What is wrong, never repeating a URL or a secret. */
	readonly problem: string;
}

/** Thrown by `readConfig` and the `bumail` command. */
export class ServerError extends Error {
	override readonly name = 'ServerError';
	readonly code: ServerErrorCode;
	/** Every problem found, for `INVALID_CONFIG`; empty otherwise. */
	readonly problems: readonly ConfigProblem[];

	constructor(
		code: ServerErrorCode,
		message: string,
		problems: readonly ConfigProblem[] = [],
	) {
		super(message);
		this.code = code;
		this.problems = problems;
	}
}

/**
 * The `INVALID_CONFIG` error for `file`: its name, then one indented
 * `path: problem` line per problem, in the order found.
 */
export function invalidConfig(
	file: string,
	problems: readonly ConfigProblem[],
): ServerError {
	const lines = problems.map(({ path, problem }) => `  ${path}: ${problem}`);
	return new ServerError(
		'INVALID_CONFIG',
		`${file}:\n${lines.join('\n')}`,
		problems,
	);
}
