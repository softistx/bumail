import { ServerError } from '../errors';

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
	  };

function usage(message: string): ServerError {
	return new ServerError('USAGE', `${message}; see bumail --help`);
}

/**
 * Reads `bumail [--config <file>] <command>`, `--help` and `--version`.
 * Throws `ServerError('USAGE')` for anything else.
 */
export function parseArgs(argv: readonly string[]): Args {
	let command: Command | undefined;
	let config: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (arg === '-h' || arg === '--help') return { kind: 'help' };
		if (arg === '-v' || arg === '--version') return { kind: 'version' };
		if (arg === '--config' || arg.startsWith('--config=')) {
			if (config !== undefined) throw usage('--config is given twice');
			const value =
				arg === '--config' ? argv[++i] : arg.slice('--config='.length);
			if (value === undefined || value === '') {
				throw usage('--config needs a file');
			}
			config = value;
			continue;
		}
		if (arg.startsWith('-')) throw usage(`unknown option ${arg}`);
		if (command !== undefined) throw usage(`unexpected argument ${arg}`);
		if (!(COMMANDS as readonly string[]).includes(arg)) {
			throw usage(`unknown command ${arg}`);
		}
		command = arg as Command;
	}
	if (command === undefined) throw usage('no command given');
	return { kind: 'command', command, config };
}
