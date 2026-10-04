import {
	isNoun,
	type ManageArgs,
	type Options,
	refuseOptions,
	resolveManage,
	usage,
	word,
} from './verbs';

export type Command = 'serve' | 'check-config';

const COMMANDS: readonly Command[] = ['serve', 'check-config'];

/** What the command line asks for. */
export type Args =
	| { readonly kind: 'help' }
	| { readonly kind: 'version' }
	| {
			readonly kind: 'command';
			readonly command: Command;
			/** `--config`, when given. */
			readonly config: string | undefined;
	  }
	| ManageArgs;

/**
 * An unknown option as a message names it: a long one without what
 * follows its `=`, a short one by its first letter alone, so neither
 * `--pw=secret` nor `-psecret`, as some tools take a password, repeats it.
 */
function optionName(arg: string): string {
	if (!arg.startsWith('--'))
		return arg.length > 2 ? `${arg.slice(0, 2)}…` : arg;
	const eq = arg.indexOf('=');
	return eq === -1 ? arg : arg.slice(0, eq);
}

/** `argv` split into its words and its options; `help` or `version` when asked. */
function readOptions(
	argv: readonly string[],
): { words: string[]; options: Options } | Args {
	const words: string[] = [];
	const options: Options = {
		config: undefined,
		passwordStdin: false,
		passwordFile: undefined,
		purge: false,
		selector: undefined,
		replace: false,
	};
	/** The value of `--name value` or `--name=value`, and the index past it. */
	const take = (i: number, name: string): [string, number] => {
		const arg = argv[i] ?? '';
		const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
		if (value === undefined || value === '') {
			throw usage(
				`${name} needs ${name === '--selector' ? 'a selector' : 'a file'}`,
			);
		}
		return [value, arg === name ? i + 1 : i];
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (arg === '-h' || arg === '--help') return { kind: 'help' };
		if (arg === '-v' || arg === '--version') return { kind: 'version' };
		if (arg === '--config' || arg.startsWith('--config=')) {
			if (options.config !== undefined) throw usage('--config is given twice');
			[options.config, i] = take(i, '--config');
		} else if (
			arg === '--password-file' ||
			arg.startsWith('--password-file=')
		) {
			if (options.passwordFile !== undefined) {
				throw usage('--password-file is given twice');
			}
			[options.passwordFile, i] = take(i, '--password-file');
		} else if (arg === '--password-stdin') {
			options.passwordStdin = true;
		} else if (arg === '--purge') {
			options.purge = true;
		} else if (arg === '--selector' || arg.startsWith('--selector=')) {
			if (options.selector !== undefined) {
				throw usage('--selector is given twice');
			}
			[options.selector, i] = take(i, '--selector');
		} else if (arg === '--replace') {
			options.replace = true;
		} else if (/^-+pass/i.test(arg)) {
			throw usage(
				'a password is never taken from the command line: use --password-stdin or --password-file, or type it at the prompt',
			);
		} else if (arg.startsWith('-')) {
			throw usage(`unknown option ${optionName(arg)}`);
		} else {
			words.push(arg);
		}
	}
	return { words, options };
}

/**
 * Reads `bumail [--config <file>] <command> [operands] [options]`,
 * `--help` and `--version`. Throws `ServerError('USAGE')` for anything
 * else, never repeating what may be a password: an operand, a command
 * word that does not read like one, or what follows an option's `=`.
 */
export function parseArgs(argv: readonly string[]): Args {
	const read = readOptions(argv);
	if (!('words' in read)) return read;
	const { words, options } = read;
	const [first, ...rest] = words;
	if (first === undefined) throw usage('no command given');
	if ((COMMANDS as readonly string[]).includes(first)) {
		if (rest.length > 0)
			throw usage(`unexpected argument ${word(rest[0] ?? '')}`);
		refuseOptions(first, options, {});
		return {
			kind: 'command',
			command: first as Command,
			config: options.config,
		};
	}
	if (!isNoun(first)) throw usage(`unknown command ${word(first)}`);
	return resolveManage(first, rest, options);
}
