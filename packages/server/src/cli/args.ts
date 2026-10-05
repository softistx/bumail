import { type DnsArgs, resolveDns } from './dns/args';
import { type HealthArgs, type InitArgs, resolveImage } from './image-args';
import { is, take as takeValue, unknownOption } from './option-syntax';
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
	| ManageArgs
	| InitArgs
	| HealthArgs
	| DnsArgs;

/** What an option that takes a value takes, for the message that it was given none. */
const NEEDS: Readonly<Record<string, string>> = {
	'--selector': 'a selector',
	'--ip': 'an IPv4 address',
	'--ip6': 'an IPv6 address',
};

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
		ip: undefined,
		ip6: undefined,
		json: false,
		check: false,
	};
	const take = (i: number, name: string): [string, number] =>
		takeValue(argv, i, name, NEEDS[name] ?? 'a file');
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (arg === '-h' || arg === '--help') return { kind: 'help' };
		if (arg === '-v' || arg === '--version') return { kind: 'version' };
		if (is(arg, '--config')) {
			if (options.config !== undefined) throw usage('--config is given twice');
			[options.config, i] = take(i, '--config');
		} else if (is(arg, '--password-file')) {
			if (options.passwordFile !== undefined) {
				throw usage('--password-file is given twice');
			}
			[options.passwordFile, i] = take(i, '--password-file');
		} else if (arg === '--password-stdin') {
			options.passwordStdin = true;
		} else if (arg === '--purge') {
			options.purge = true;
		} else if (is(arg, '--selector')) {
			if (options.selector !== undefined) {
				throw usage('--selector is given twice');
			}
			[options.selector, i] = take(i, '--selector');
		} else if (arg === '--replace') {
			options.replace = true;
		} else if (arg === '--json') {
			options.json = true;
		} else if (arg === '--check') {
			options.check = true;
		} else if (is(arg, '--ip')) {
			if (options.ip !== undefined) throw usage('--ip is given twice');
			[options.ip, i] = take(i, '--ip');
		} else if (is(arg, '--ip6')) {
			if (options.ip6 !== undefined) throw usage('--ip6 is given twice');
			[options.ip6, i] = take(i, '--ip6');
		} else if (arg.startsWith('-')) {
			throw unknownOption(arg);
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
	const image = resolveImage(argv);
	if (image !== undefined) return image;
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
	if (first === 'dns') return resolveDns(rest, options);
	if (!isNoun(first)) throw usage(`unknown command ${word(first)}`);
	return resolveManage(first, rest, options);
}
