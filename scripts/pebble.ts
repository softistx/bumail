#!/usr/bin/env bun
/**
 * Starts Pebble, Let's Encrypt's ACME test server, in Docker, for
 * `@bumail/acme`'s client specs, and prints the line that points them at
 * it.
 *
 *   bun run pebble:test         # start (or reuse) Pebble, wait, print the variables
 *   bun run pebble:test stop    # remove the container
 *
 * The container is `bumail-pebble-test`, its ACME API on port 14000 of
 * 127.0.0.1 (`BUMAIL_TEST_PEBBLE_PORT` to change it). Pebble validates
 * HTTP-01 for real: the names the specs order (`PEBBLE_NAMES`) resolve,
 * inside the container, to the host (`--add-host <name>:host-gateway`),
 * where the specs answer on port 5002, the `httpPort` of Pebble's own
 * configuration. Pebble's API is served under a test CA of its own, the
 * file this script copies out of the container and names in
 * `BUMAIL_TEST_PEBBLE_CA`. Without `BUMAIL_TEST_PEBBLE_URL` those specs
 * are skipped, saying so; CI sets it to a `services: pebble` container.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docker, main, portFrom } from './containers';

export const CONTAINER = 'bumail-pebble-test';
export const IMAGE = 'ghcr.io/letsencrypt/pebble:2.10.1';
const PORT_VARIABLE = 'BUMAIL_TEST_PEBBLE_PORT';
/** The names the specs order, each resolving to the host inside the container. */
export const PEBBLE_NAMES = [
	'a.bumail.test',
	'b.bumail.test',
	'c.bumail.test',
	'd.bumail.test',
];
/** Where Pebble's image keeps the CA its API's certificate is issued under. */
const CA_IN_IMAGE = '/test/certs/pebble.minica.pem';

/** The port on 127.0.0.1, from the environment or 14000. */
export const portOf = (value: string | undefined): number =>
	portFrom(PORT_VARIABLE, value, 14000);

/** What the specs read from `BUMAIL_TEST_PEBBLE_URL`: the directory. Its certificate names `localhost`. */
export const urlOf = (port: number) => `https://localhost:${port}/dir`;

/** Where the CA is copied to. */
export const caPath = () => join(tmpdir(), 'bumail-pebble-ca.pem');

/** `docker run` for a new container, its API published on loopback only. */
export const runArgs = (port: number) => [
	'docker',
	'run',
	'--detach',
	'--name',
	CONTAINER,
	'--publish',
	`127.0.0.1:${port}:14000`,
	// No random sleep before validating; `badNonce` stays at Pebble's 5 %,
	// so the client's retry runs too.
	'--env',
	'PEBBLE_VA_NOSLEEP=1',
	...PEBBLE_NAMES.flatMap((name) => ['--add-host', `${name}:host-gateway`]),
	IMAGE,
];

/** Copies the CA out, then waits until the directory answers over TLS under it. */
async function ready(url: string): Promise<void> {
	const ca = caPath();
	for (let i = 0; i < 120; i++) {
		if (
			docker(['docker', 'cp', `${CONTAINER}:${CA_IN_IMAGE}`, ca], 'ignore').ok
		) {
			try {
				const answer = await fetch(url, {
					tls: { ca: await Bun.file(ca).text() },
				});
				if (answer.ok) return;
			} catch {
				// not listening yet
			}
		}
		await Bun.sleep(500);
	}
	throw new Error(`Pebble at ${url} did not answer within a minute`);
}

if (import.meta.main) {
	const port = portOf(process.env.BUMAIL_TEST_PEBBLE_PORT);
	await main(
		{
			name: CONTAINER,
			port,
			runArgs: runArgs(port),
			script: 'pebble:test',
			portVariable: PORT_VARIABLE,
		},
		() => ready(urlOf(port)),
		`export BUMAIL_TEST_PEBBLE_URL=${urlOf(port)} BUMAIL_TEST_PEBBLE_CA=${caPath()}`,
	);
}
