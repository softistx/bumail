import { type HealthArgs, resolveHealth } from './health/args';
import { type InitArgs, resolveInit } from './init/args';
import { tokenize } from './tokens';

export type { HealthArgs, InitArgs };

/** `bumail init …` or `bumail health …` as arguments; `undefined` for any other command. */
export function resolveImage(
	argv: readonly string[],
): InitArgs | HealthArgs | undefined {
	const tokens = tokenize(argv);
	if (tokens === undefined) return undefined;
	return tokens.command === 'init'
		? resolveInit(tokens)
		: resolveHealth(tokens);
}
