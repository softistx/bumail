#!/usr/bin/env bun
/**
 * Starts the MongoDB the queue's MongoDB specs run against, in Docker,
 * and prints the line that points them at it.
 *
 *   bun run mongo:test         # start (or reuse) mongo:7, wait, print the URL
 *   bun run mongo:test stop    # remove the container
 *
 * The container is `bumail-mongo-test`, on port 57017 of 127.0.0.1
 * (`BUMAIL_TEST_MONGO_PORT` to change it): a standalone server — the
 * store needs no transaction, so no replica set — with access control on
 * and a throwaway root password, so the specs that give a user only some
 * roles mean something. It holds nothing but the specs' collections,
 * which they drop. Without `BUMAIL_TEST_MONGO_URL` those specs are
 * skipped, saying so; CI sets it to a `services: mongo` container of its
 * own.
 */
import { docker, main, portFrom } from './containers';

export const CONTAINER = 'bumail-mongo-test';
export const IMAGE = 'mongo:7';
const USER = 'root';
const PASSWORD = 'bumail';
const DATABASE = 'bumail_test';
const PORT_VARIABLE = 'BUMAIL_TEST_MONGO_PORT';

/** The port on 127.0.0.1, from the environment or 57017. */
export const portOf = (value: string | undefined): number =>
	portFrom(PORT_VARIABLE, value, 57017);

/** What the specs read from `BUMAIL_TEST_MONGO_URL`: the root user, authenticated against `admin`. */
export const urlOf = (port: number) =>
	`mongodb://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}?authSource=admin`;

/** `docker run` for a new container, published on loopback only. */
export const runArgs = (port: number) => [
	'docker',
	'run',
	'--detach',
	'--name',
	CONTAINER,
	'--env',
	`MONGO_INITDB_ROOT_USERNAME=${USER}`,
	'--env',
	`MONGO_INITDB_ROOT_PASSWORD=${PASSWORD}`,
	'--publish',
	`127.0.0.1:${port}:27017`,
	IMAGE,
];

/**
 * Asks the server, through the image's own `mongosh`, whether it is the
 * one that listens: during its first start the image runs a server on
 * 127.0.0.1 only, to make the root user, then restarts it with
 * `--bind_ip_all`.
 */
const PROBE =
	"db.adminCommand({ getCmdLineOpts: 1 }).argv.includes('--bind_ip_all') ? 'up' : 'init'";

/** Waits until the server that listens answers, as the root user. */
async function ready(): Promise<void> {
	for (let i = 0; i < 120; i++) {
		const { ok, out } = docker(
			[
				'docker',
				'exec',
				CONTAINER,
				'mongosh',
				'--quiet',
				'--username',
				USER,
				'--password',
				PASSWORD,
				'--authenticationDatabase',
				'admin',
				'--eval',
				PROBE,
			],
			'ignore',
		);
		if (ok && out.endsWith('up')) return;
		await Bun.sleep(500);
	}
	throw new Error(`MongoDB in ${CONTAINER} did not answer within a minute`);
}

if (import.meta.main) {
	const port = portOf(process.env.BUMAIL_TEST_MONGO_PORT);
	await main(
		{
			name: CONTAINER,
			port,
			runArgs: runArgs(port),
			script: 'mongo:test',
			portVariable: PORT_VARIABLE,
		},
		ready,
		`export BUMAIL_TEST_MONGO_URL='${urlOf(port)}'`,
	);
}
