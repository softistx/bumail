import { describe, test } from 'bun:test';
import type { AcmeFetch } from './http';

/**
 * Pebble, Let's Encrypt's ACME test server, from the environment: `bun
 * run pebble:test` starts one in Docker and prints the two variables to
 * set — the directory URL, and the file of the CA Pebble's API is served
 * under, which the specs' `fetch` trusts. CI's "CI" job runs it as a
 * service.
 */
export const PEBBLE_URL = process.env['BUMAIL_TEST_PEBBLE_URL'];
const PEBBLE_CA = process.env['BUMAIL_TEST_PEBBLE_CA'];

/**
 * The names the specs order. Each resolves, inside Pebble's container, to
 * the host (`--add-host <name>:host-gateway`, in `scripts/pebble.ts` and
 * CI's service alike), where the specs answer HTTP-01 on `HTTP01_PORT`.
 */
export const PEBBLE_NAMES = [
	'a.bumail.test',
	'b.bumail.test',
	'c.bumail.test',
	'd.bumail.test',
] as const;

/** Where Pebble's validation authority fetches HTTP-01 answers: its default `httpPort`. */
export const HTTP01_PORT = 5002;

const SKIPPED =
	'BUMAIL_TEST_PEBBLE_URL is not set: start Pebble with `bun run pebble:test` and export the variables it prints';

/** What a Pebble spec gets: the directory, and a `fetch` that trusts Pebble's CA. */
export interface Pebble {
	directoryUrl: string;
	fetch: AcmeFetch;
}

/**
 * `describe` with Pebble when there is one; otherwise one skipped test
 * that says how to run them, and a warning — or, with
 * `BUMAIL_TEST_PEBBLE_REQUIRED` set, an error.
 */
export function describePebble(
	name: string,
	body: (pebble: Pebble) => void,
): void {
	if (PEBBLE_URL) {
		if (!PEBBLE_CA) {
			throw new Error(
				"BUMAIL_TEST_PEBBLE_URL is set but BUMAIL_TEST_PEBBLE_CA is not: it names the file of Pebble's CA, which `bun run pebble:test` copies out",
			);
		}
		const ca = Bun.file(PEBBLE_CA).text();
		const fetchWithCa: AcmeFetch = async (input, init) =>
			await fetch(input, { ...init, tls: { ca: await ca } });
		describe(name, () =>
			body({ directoryUrl: PEBBLE_URL, fetch: fetchWithCa }),
		);
		return;
	}
	if (process.env['BUMAIL_TEST_PEBBLE_REQUIRED']) {
		throw new Error(
			'BUMAIL_TEST_PEBBLE_REQUIRED is set but BUMAIL_TEST_PEBBLE_URL is not: the Pebble specs cannot run',
		);
	}
	console.warn(`Pebble specs skipped: ${SKIPPED}`);
	describe(name, () => test.skip(SKIPPED, () => {}));
}
