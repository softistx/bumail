import { usage } from './verbs';

/**
 * An unknown option as a message names it: a long one without what
 * follows its `=`, a short one by its first letter alone, so neither
 * `--pw=secret` nor `-psecret`, as some tools take a password, repeats it.
 */
export function optionName(arg: string): string {
	if (!arg.startsWith('--'))
		return arg.length > 2 ? `${arg.slice(0, 2)}…` : arg;
	const eq = arg.indexOf('=');
	return eq === -1 ? arg : arg.slice(0, eq);
}

/** Whether `arg` is `name` or `name=value`. */
export const is = (arg: string, name: string): boolean =>
	arg === name || arg.startsWith(`${name}=`);

/** Refuses an option that looks like a password given on the command line. */
export function refusePassword(arg: string): void {
	if (/^-+pass/i.test(arg)) {
		throw usage(
			'a password is never taken from the command line: use --password-stdin or --password-file, or type it at the prompt',
		);
	}
}

/**
 * The value of `--name value` or `--name=value` at `argv[i]`, and the
 * index past it; `needs` says what the option takes when it has none.
 */
export function take(
	argv: readonly string[],
	i: number,
	name: string,
	needs: string,
): [string, number] {
	const arg = argv[i] ?? '';
	const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
	if (value === undefined || value === '')
		throw usage(`${name} needs ${needs}`);
	return [value, arg === name ? i + 1 : i];
}

/** The usage error of an option that no command takes. */
export function unknownOption(arg: string): Error {
	refusePassword(arg);
	return usage(`unknown option ${optionName(arg)}`);
}
