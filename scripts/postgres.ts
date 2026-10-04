#!/usr/bin/env bun
/**
 * Starts the PostgreSQL the queue's PostgreSQL specs run against, in
 * Docker, and prints the line that points them at it.
 *
 *   bun run postgres:test         # start (or reuse) postgres:17, wait, print the URL
 *   bun run postgres:test stop    # remove the container
 *
 * The container is `bumail-postgres-test`, on port 55432 of 127.0.0.1
 * (`BUMAIL_TEST_POSTGRES_PORT` to change it), with a throwaway password:
 * it holds nothing but the specs' tables, which they drop. Without
 * `BUMAIL_TEST_POSTGRES_URL` those specs are skipped, saying so; CI sets
 * it to a `services: postgres` container of its own.
 */

export const CONTAINER = 'bumail-postgres-test';
export const IMAGE = 'postgres:17';
const PASSWORD = 'bumail';
const DATABASE = 'bumail_test';

/** The port on 127.0.0.1, from the environment or 55432. */
export function portOf(value: string | undefined): number {
	const port = Number(value ?? 55432);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`BUMAIL_TEST_POSTGRES_PORT must be a port, not ${value}`);
	}
	return port;
}

/** What the specs read from `BUMAIL_TEST_POSTGRES_URL`. */
export const urlOf = (port: number) =>
	`postgres://postgres:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`;

/** `docker run` for a new container, published on loopback only. */
export const runArgs = (port: number) => [
	'docker',
	'run',
	'--detach',
	'--name',
	CONTAINER,
	'--env',
	`POSTGRES_PASSWORD=${PASSWORD}`,
	'--env',
	`POSTGRES_DB=${DATABASE}`,
	'--publish',
	`127.0.0.1:${port}:5432`,
	IMAGE,
];

/** What `docker inspect` said of the container: running or not, and its published port. */
export function containerOf(out: string): { running: boolean; port: number } {
	const [running, port] = out.trim().split(' ');
	return { running: running === 'true', port: Number(port ?? 0) };
}

function docker(
	args: string[],
	stderr: 'inherit' | 'ignore' = 'inherit',
): { ok: boolean; out: string } {
	const run = Bun.spawnSync(args, { stderr });
	return { ok: run.exitCode === 0, out: run.stdout.toString().trim() };
}

/** Starts the container, or the stopped one, unless it runs already. */
function start(port: number): void {
	// Not there yet is an answer, not an error.
	const state = docker(
		[
			'docker',
			'inspect',
			'--format',
			'{{.State.Running}} {{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}}{{end}}{{end}}',
			CONTAINER,
		],
		'ignore',
	);
	const { running, port: published } = containerOf(state.out);
	if (state.ok && published !== port) {
		throw new Error(
			`${CONTAINER} exists on port ${published || 'none'}, not ${port}: run \`bun run postgres:test stop\` first, or set BUMAIL_TEST_POSTGRES_PORT=${published}`,
		);
	}
	if (running) return;
	const started = state.ok
		? docker(['docker', 'start', CONTAINER])
		: docker(runArgs(port));
	if (!started.ok) throw new Error(`docker could not start ${CONTAINER}`);
}

/**
 * Waits until a query answers over TCP: during its first start the image
 * runs a server on its socket only, then restarts it listening.
 */
async function ready(url: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 2 });
		try {
			await sql.unsafe('SELECT 1');
			return;
		} catch {
			await Bun.sleep(500);
		} finally {
			await sql.close({ timeout: 0 });
		}
	}
	throw new Error(`PostgreSQL at ${url} did not answer within a minute`);
}

if (import.meta.main) {
	const port = portOf(process.env.BUMAIL_TEST_POSTGRES_PORT);
	if (process.argv[2] === 'stop') {
		docker(['docker', 'rm', '--force', CONTAINER]);
	} else {
		try {
			start(port);
			await ready(urlOf(port));
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		}
		console.log(`export BUMAIL_TEST_POSTGRES_URL=${urlOf(port)}`);
	}
}
