#!/usr/bin/env bun
/**
 * Starts the PostgreSQL the specs of `@bumail/queue/postgres` and
 * `@bumail/store/postgres` run against, in Docker, and prints the line
 * that points them at it.
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
import { main, portFrom } from './containers';

export const CONTAINER = 'bumail-postgres-test';
export const IMAGE = 'postgres:17';
const PASSWORD = 'bumail';
const DATABASE = 'bumail_test';
const PORT_VARIABLE = 'BUMAIL_TEST_POSTGRES_PORT';

/** The port on 127.0.0.1, from the environment or 55432. */
export const portOf = (value: string | undefined): number =>
	portFrom(PORT_VARIABLE, value, 55432);

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
	await main(
		{
			name: CONTAINER,
			port,
			runArgs: runArgs(port),
			script: 'postgres:test',
			portVariable: PORT_VARIABLE,
		},
		() => ready(urlOf(port)),
		`export BUMAIL_TEST_POSTGRES_URL=${urlOf(port)}`,
	);
}
