import { ServerError } from '../errors';

export type Command = 'serve' | 'check-config';

const COMMANDS: readonly Command[] = ['serve', 'check-config'];

/** What manages the directory: `bumail <noun> <verb> …`. */
export type Noun = 'domain' | 'user' | 'alias';

/** Where a new password comes from: never the command line. */
export type PasswordSource =
	| { readonly from: 'prompt' }
	| { readonly from: 'stdin' }
	| { readonly from: 'file'; readonly file: string };

interface VerbSpec {
	/** Operands, at least and at most. */
	readonly min: number;
	readonly max: number;
	/** What they are, for the usage message. */
	readonly operands: string;
	/** Takes a new password. */
	readonly password?: boolean;
	/** Takes `--purge`. */
	readonly purge?: boolean;
}

/** Each noun's verbs. */
const VERBS: Readonly<Record<Noun, Readonly<Record<string, VerbSpec>>>> = {
	domain: {
		add: { min: 1, max: 1, operands: 'one domain' },
		list: { min: 0, max: 0, operands: 'nothing' },
		remove: { min: 1, max: 1, operands: 'one domain' },
	},
	user: {
		add: { min: 1, max: 1, operands: 'one address', password: true },
		list: { min: 0, max: 1, operands: 'a domain at most' },
		passwd: { min: 1, max: 1, operands: 'one address', password: true },
		disable: { min: 1, max: 1, operands: 'one address' },
		enable: { min: 1, max: 1, operands: 'one address' },
		remove: { min: 1, max: 1, operands: 'one address', purge: true },
	},
	alias: {
		add: {
			min: 2,
			max: Number.POSITIVE_INFINITY,
			operands: 'an address, then one or more users',
		},
		list: { min: 0, max: 1, operands: 'a domain at most' },
		remove: { min: 1, max: 1, operands: 'one address' },
	},
};

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
	| {
			readonly kind: 'manage';
			readonly noun: Noun;
			readonly verb: string;
			readonly operands: readonly string[];
			readonly config: string | undefined;
			/** For `user add` and `user passwd`. */
			readonly password: PasswordSource | undefined;
			/** `user remove --purge`. */
			readonly purge: boolean;
	  };

function usage(message: string): ServerError {
	return new ServerError('USAGE', `${message}; see bumail --help`);
}

/** `a, b or c`. */
function oneOf(words: readonly string[]): string {
	return words.length < 2
		? (words[0] ?? '')
		: `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

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

/** The options read, wherever they stand. */
interface Options {
	config: string | undefined;
	passwordStdin: boolean;
	passwordFile: string | undefined;
	purge: boolean;
}

/**
 * Reads `bumail [--config <file>] <command> [operands] [options]`,
 * `--help` and `--version`. Throws `ServerError('USAGE')` for anything
 * else, never repeating what may be a password: an operand of a
 * directory command, or what follows an option's `=`.
 */
export function parseArgs(argv: readonly string[]): Args {
	const words: string[] = [];
	const options: Options = {
		config: undefined,
		passwordStdin: false,
		passwordFile: undefined,
		purge: false,
	};
	/** The value of `--name value` or `--name=value`, and the index past it. */
	const take = (i: number, name: string): [string, number] => {
		const arg = argv[i] ?? '';
		const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
		if (value === undefined || value === '') {
			throw usage(`${name} needs a file`);
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

	const [first, ...rest] = words;
	if (first === undefined) throw usage('no command given');
	if ((COMMANDS as readonly string[]).includes(first)) {
		if (rest.length > 0) throw usage(`unexpected argument ${rest[0]}`);
		refuseOptions(first, options, {});
		return {
			kind: 'command',
			command: first as Command,
			config: options.config,
		};
	}
	if (!Object.hasOwn(VERBS, first)) throw usage(`unknown command ${first}`);
	const noun = first as Noun;
	const verbs = VERBS[noun];
	const [verb, ...operands] = rest;
	if (verb === undefined) {
		throw usage(`${noun} needs a command: ${oneOf(Object.keys(verbs))}`);
	}
	const spec = Object.hasOwn(verbs, verb) ? verbs[verb] : undefined;
	if (spec === undefined) {
		throw usage(
			`unknown command ${noun} ${verb}; ${noun} takes ${oneOf(Object.keys(verbs))}`,
		);
	}
	const name = `${noun} ${verb}`;
	if (operands.length < spec.min || operands.length > spec.max) {
		throw usage(
			spec.password === true
				? `${name} takes ${spec.operands}: a password is never taken from the command line`
				: `${name} takes ${spec.operands}`,
		);
	}
	refuseOptions(name, options, spec);
	if (options.passwordStdin && options.passwordFile !== undefined) {
		throw usage(
			'--password-stdin and --password-file are both given; give one',
		);
	}
	return {
		kind: 'manage',
		noun,
		verb,
		operands,
		config: options.config,
		password: spec.password !== true ? undefined : passwordSource(options),
		purge: options.purge,
	};
}

function passwordSource(options: Options): PasswordSource {
	if (options.passwordStdin) return { from: 'stdin' };
	if (options.passwordFile !== undefined) {
		return { from: 'file', file: options.passwordFile };
	}
	return { from: 'prompt' };
}

/** Refuses an option the command does not take. */
function refuseOptions(
	name: string,
	options: Options,
	spec: Partial<VerbSpec>,
): void {
	if (spec.password !== true) {
		if (options.passwordStdin) throw usage(`${name} takes no --password-stdin`);
		if (options.passwordFile !== undefined) {
			throw usage(`${name} takes no --password-file`);
		}
	}
	if (options.purge && spec.purge !== true) {
		throw usage(`${name} takes no --purge`);
	}
}
