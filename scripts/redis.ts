#!/usr/bin/env bun
/**
 * Starts the Redis the queue's Redis specs run against, in Docker, and
 * prints the line that points them at it.
 *
 *   bun run redis:test         # start (or reuse) redis:7, wait, print the URL
 *   bun run redis:test stop    # remove the container
 *
 * The container is `bumail-redis-test`, on port 56380 of 127.0.0.1
 * (`BUMAIL_TEST_REDIS_PORT` to change it), with no password and no
 * persistence: it holds nothing but the specs' keys, which they delete.
 * Without `BUMAIL_TEST_REDIS_URL` those specs are skipped, saying so; CI
 * sets it to a `services: redis` container of its own.
 */
import { main, portFrom } from './containers';

export const CONTAINER = 'bumail-redis-test';
export const IMAGE = 'redis:7';
const PORT_VARIABLE = 'BUMAIL_TEST_REDIS_PORT';

/** The port on 127.0.0.1, from the environment or 56380. */
export const portOf = (value: string | undefined): number =>
	portFrom(PORT_VARIABLE, value, 56380);

/** What the specs read from `BUMAIL_TEST_REDIS_URL`. */
export const urlOf = (port: number) => `redis://127.0.0.1:${port}`;

/** `docker run` for a new container, published on loopback only. */
export const runArgs = (port: number) => [
	'docker',
	'run',
	'--detach',
	'--name',
	CONTAINER,
	'--publish',
	`127.0.0.1:${port}:6379`,
	IMAGE,
];

/** Waits until a PING answers. */
async function ready(url: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		const client = new Bun.RedisClient(url, {
			maxRetries: 0,
			connectionTimeout: 2000,
		});
		try {
			await client.send('PING', []);
			return;
		} catch {
			await Bun.sleep(500);
		} finally {
			client.close();
		}
	}
	throw new Error(`Redis at ${url} did not answer within a minute`);
}

if (import.meta.main) {
	const port = portOf(process.env.BUMAIL_TEST_REDIS_PORT);
	await main(
		{
			name: CONTAINER,
			port,
			runArgs: runArgs(port),
			script: 'redis:test',
			portVariable: PORT_VARIABLE,
		},
		() => ready(urlOf(port)),
		`export BUMAIL_TEST_REDIS_URL=${urlOf(port)}`,
	);
}
