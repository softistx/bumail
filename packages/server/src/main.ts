#!/usr/bin/env bun
/**
 * The `bumail` command: `serve`, `check-config`, `--help`, `--version`.
 * What it does is `run`'s; this file only hands it the process.
 */
import { run } from './cli/run';

const manifest = await Bun.file(
	new URL('../package.json', import.meta.url),
).json();

process.exitCode = await run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: process.env,
	version: String(manifest.version),
});
