import type { Resolver } from '@bumail/dns';
import { readConfig } from '../config/read';
import { ServerError, type ServerErrorCode } from '../errors';
import { parseArgs } from './args';
import { dnsCommand } from './dns';
import { HELP } from './help';
import { manage } from './manage';
import type { Terminal } from './secret';
import { serveUntilSignal } from './serve';
import { summary } from './summary';

/** Where the command writes, and what it reads. */
export interface Io {
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly version: string;
	/** The DNS `dns --check` queries; default `node:dns`. */
	readonly resolver?: Resolver;
	/** Where a new password is read from. */
	readonly terminal: Terminal;
	/**
	 * Calls `handler` with each SIGTERM or SIGINT, for `serve`; answers
	 * what stops listening. Without it, `serve` stops at once.
	 */
	readonly signals?: (handler: (signal: string) => void) => () => void;
	/**
	 * Calls `handler` with each SIGHUP, for `serve`, which looks for a
	 * renewed certificate; answers what stops listening. Without it, a
	 * SIGHUP is left to the platform.
	 */
	readonly reloads?: (handler: () => void) => () => void;
}

/** The exit codes `--help` lists. */
export const EXIT = {
	ok: 0,
	invalidConfig: 1,
	usage: 2,
	notImplemented: 3,
	refused: 4,
	unavailable: 5,
	/** `dns --check`: a record is missing or differs; the value of `invalidConfig`, since both are "not as it should be". */
	dnsDiffers: 1,
} as const;

const EXIT_OF: Record<ServerErrorCode, number> = {
	INVALID_CONFIG: EXIT.invalidConfig,
	USAGE: EXIT.usage,
	INVALID: EXIT.refused,
	NOT_FOUND: EXIT.refused,
	ALREADY_EXISTS: EXIT.refused,
	IN_USE: EXIT.refused,
	UNAVAILABLE: EXIT.unavailable,
	NOT_IMPLEMENTED: EXIT.notImplemented,
};

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
		if (args.kind === 'dns') {
			return (await dnsCommand(args, config, io)) ? EXIT.ok : EXIT.dnsDiffers;
		}
		if (args.kind === 'manage') {
			await manage(args, config, io);
			return EXIT.ok;
		}
		if (args.command === 'check-config') {
			io.out(`${summary(config)}\n`);
			return EXIT.ok;
		}
		return await serveUntilSignal(config, io);
	} catch (error) {
		if (!(error instanceof ServerError)) throw error;
		io.err(`bumail: ${error.message}\n`);
		return EXIT_OF[error.code];
	}
}
