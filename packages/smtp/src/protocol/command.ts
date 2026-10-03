import { type Path, parsePath } from './path';

/** A command line, split into its verb (upper case) and the rest. */
export interface Command {
	readonly verb: string;
	readonly argument: string;
}

export function parseCommand(line: string): Command {
	const space = line.indexOf(' ');
	if (space < 0) return { verb: line.toUpperCase(), argument: '' };
	return {
		verb: line.slice(0, space).toUpperCase(),
		argument: line.slice(space + 1).trim(),
	};
}

/** `MAIL FROM:<path> params` or `RCPT TO:<path> params`, parsed. */
export interface PathCommand {
	readonly path: Path;
	/** ESMTP parameters (RFC 5321 §4.1.2), keys in upper case; a key with no `=` has the value `''`. */
	readonly parameters: Readonly<Record<string, string>>;
}

/**
 * Parses the argument of `MAIL` or `RCPT`: `FROM:<path> params` (or `TO:`).
 * Tolerates a space after the colon, which many clients send. `undefined`
 * when the syntax is wrong.
 */
export function parsePathCommand(
	argument: string,
	keyword: 'FROM' | 'TO',
): PathCommand | undefined {
	const match = new RegExp(`^${keyword}:\\s*(<[^>]*>)(.*)$`, 'i').exec(
		argument,
	);
	if (!match) return undefined;
	const path = parsePath(match[1] as string, keyword === 'FROM');
	if (!path) return undefined;
	const parameters: Record<string, string> = {};
	for (const item of (match[2] as string).trim().split(/\s+/)) {
		if (item === '') continue;
		const equals = item.indexOf('=');
		const key = (equals < 0 ? item : item.slice(0, equals)).toUpperCase();
		if (!/^[A-Z0-9][A-Z0-9-]*$/.test(key)) return undefined;
		parameters[key] = equals < 0 ? '' : item.slice(equals + 1);
	}
	return { path, parameters };
}
