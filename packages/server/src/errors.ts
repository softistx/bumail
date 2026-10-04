/**
 * What went wrong, as a code to branch on:
 *
 * - `INVALID_CONFIG`: the configuration cannot be read, is not TOML, or
 *   breaks a rule. The message names the file, then one `path: problem`
 *   line per problem, each also in `problems`.
 * - `USAGE`: the `bumail` command was given an argument it does not take.
 * - `INVALID`: the directory refuses a value: not a domain name, not an
 *   address, a password too short or too long, an alias target that is
 *   not a local user.
 * - `NOT_FOUND`: no such domain, user or alias.
 * - `ALREADY_EXISTS`: the domain, user or alias is already there, or the
 *   address is taken by a user (for an alias) or an alias (for a user).
 * - `IN_USE`: what would be removed is still used: a domain with users
 *   or aliases, a user an alias points to.
 * - `UNAVAILABLE`: the directory or the mail store cannot be opened or
 *   read, or is held by another process; or `serve` cannot bind a port,
 *   read the certificate or use its spool directory.
 * - `NOT_IMPLEMENTED`: `serve` was asked for what arrives in a later
 *   release: `tls.mode = "acme"`.
 */
export type ServerErrorCode =
	| 'INVALID_CONFIG'
	| 'USAGE'
	| 'INVALID'
	| 'NOT_FOUND'
	| 'ALREADY_EXISTS'
	| 'IN_USE'
	| 'UNAVAILABLE'
	| 'NOT_IMPLEMENTED';

/** One thing wrong with a configuration: where, and what. */
export interface ConfigProblem {
	/** The key, dotted from the top (`ports.mx`), or the environment variable (`BUMAIL_STORE_URL`). */
	readonly path: string;
	/** What is wrong, never repeating a URL or a secret. */
	readonly problem: string;
}

/** Thrown by `readConfig`, the directory and the `bumail` command. */
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
