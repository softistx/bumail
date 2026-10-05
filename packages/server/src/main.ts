#!/usr/bin/env bun
/**
 * The `bumail` command: `serve`, `check-config`, `domain`, `user`,
 * `alias`, `dkim`, `init`, `health`, `--help`, `--version`. What it does is `run`'s; this file only
 * hands it the process.
 */
import { run } from './cli/run';
import { promptHidden, readStdin } from './cli/secret';

/**
 * Set by the image's build (`bun build --compile --define`), whose binary
 * has no `package.json` beside it; otherwise the package's own.
 */
declare const BUMAIL_COMPILED_VERSION: string | undefined;

const version =
	typeof BUMAIL_COMPILED_VERSION === 'string'
		? BUMAIL_COMPILED_VERSION
		: String(
				(await Bun.file(new URL('../package.json', import.meta.url)).json())
					.version,
			);

process.exitCode = await run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: process.env,
	version,
	terminal: {
		stdin: readStdin,
		isTTY: process.stdin.isTTY === true,
		prompt: promptHidden,
	},
	reloads: (handler) => {
		process.on('SIGHUP', handler);
		return () => {
			process.off('SIGHUP', handler);
		};
	},
	signals: (handler) => {
		const on = (signal: NodeJS.Signals) => handler(signal);
		process.on('SIGTERM', on);
		process.on('SIGINT', on);
		return () => {
			process.off('SIGTERM', on);
			process.off('SIGINT', on);
		};
	},
});
