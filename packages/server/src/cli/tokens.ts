import { usage, word } from './verbs';

/** What `bumail init` and `bumail health` take: options with a value, and options without. */
const VALUED: Readonly<Record<string, string>> = {
	'--config': 'a file',
	'--hostname': 'a host name',
	'--data': 'a directory',
	'--domain': 'a domain',
	'--acme-email': 'an e-mail address',
	'--acme-directory': 'an https: URL',
	'--trusted-proxy': 'an address or a CIDR',
};
const FLAGS: readonly string[] = [
	'--acme-staging',
	'--behind-traefik',
	'--proxy-protocol',
	'--force',
	'--tls-pending',
];

/** The command line of `init` or `health`, read but not yet checked against the command. */
export interface Tokens {
	readonly command: 'init' | 'health';
	/** Each valued option, with every value given, in order. */
	readonly values: ReadonlyMap<string, readonly string[]>;
	readonly flags: ReadonlySet<string>;
}

/** The command word, past `--config <file>`: the first word that is not an option. */
function commandOf(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (arg === '--config') i++;
		else if (!arg.startsWith('-')) return arg;
	}
	return undefined;
}

/** Whether `arg` is `name` or `name=value`. */
const is = (arg: string, name: string) =>
	arg === name || arg.startsWith(`${name}=`);

/**
 * `argv` split into options and flags when its command is `init` or
 * `health`; `undefined` for any other command. Only the shape is checked
 * here (an option with no value, an unknown option, an operand): what each
 * command takes is its own validator's.
 */
export function tokenize(argv: readonly string[]): Tokens | undefined {
	const command = commandOf(argv);
	if (command !== 'init' && command !== 'health') return undefined;
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	let seen = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (!seen && arg === command) {
			seen = true;
			continue;
		}
		if (!arg.startsWith('-')) throw usage(`unexpected argument ${word(arg)}`);
		const name = Object.keys(VALUED).find((key) => is(arg, key));
		if (name !== undefined) {
			const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
			if (value === undefined || value === '') {
				throw usage(`${name} needs ${VALUED[name]}`);
			}
			if (arg === name) i++;
			values.set(name, [...(values.get(name) ?? []), value]);
		} else if (FLAGS.includes(arg)) {
			flags.add(arg);
		} else {
			throw usage(`unknown option ${arg.split('=')[0]?.slice(0, 20) ?? ''}`);
		}
	}
	return { command, values, flags };
}

/** The one value of `name`, `undefined` when not given; given twice is a usage error. */
export function once(tokens: Tokens, name: string): string | undefined {
	const found = tokens.values.get(name) ?? [];
	if (found.length > 1) throw usage(`${name} is given twice`);
	return found[0];
}
