import { readConfig } from '../config/read';
import { ServerError } from '../errors';
import { parseArgs } from './args';
import { HELP } from './help';
import { summary } from './summary';

/** Where the command writes, and what it reads. */
export interface Io {
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly version: string;
}

/** The exit codes `--help` lists. */
export const EXIT = {
	ok: 0,
	invalidConfig: 1,
	usage: 2,
	notImplemented: 3,
} as const;

/** Runs `bumail` with `argv` (without the executable), answering its exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
	try {
		const args = parseArgs(argv);
		if (args.kind === 'help') {
			io.out(HELP);
			return EXIT.ok;
		}
		if (args.kind === 'version') {
			io.out(`${io.version}\n`);
			return EXIT.ok;
		}
		const config = await readConfig({
			...(args.config === undefined ? {} : { path: args.config }),
			env: io.env,
		});
		if (args.command === 'check-config') {
			io.out(`${summary(config)}\n`);
			return EXIT.ok;
		}
		io.err(
			`bumail serve: ${config.file} is valid, but serving is not implemented yet\n`,
		);
		return EXIT.notImplemented;
	} catch (error) {
		if (!(error instanceof ServerError)) throw error;
		io.err(`bumail: ${error.message}\n`);
		return error.code === 'USAGE' ? EXIT.usage : EXIT.invalidConfig;
	}
}
