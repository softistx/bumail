import { describe, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AcmeFetch } from '@bumail/acme';
import { fixtureResolver } from '@bumail/dns';
import { tempDir } from '../config/config.fixtures';
import { readConfig } from '../config/read';
import type { AcmeOptions } from './acme';
import {
	type ListenerName,
	type RunningServer,
	type ServeOptions,
	serve,
} from './serve';
import { RECORDS, seed } from './serve.fixtures';
import { implicitPeer, type Peer, startTlsPeer } from './tls-peer.fixtures';

const PEBBLE_URL = process.env['BUMAIL_TEST_PEBBLE_URL'];
const PEBBLE_CA = process.env['BUMAIL_TEST_PEBBLE_CA'];

/** Where Pebble's validation authority fetches HTTP-01 answers: its `httpPort`. */
export const HTTP01_PORT = 5002;

/** The names Pebble resolves, inside its container, to this host. */
export const NAMES = ['a.bumail.test', 'b.bumail.test'] as const;

/** A directory URL no spec reaches: the CA's `fetch` is always the spec's. */
export const FAKE_DIRECTORY = 'https://ca.example.invalid/dir';

/** A port free a moment ago. */
export function freePort(): number {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { data() {} },
	});
	const { port } = listener;
	listener.stop(true);
	return port;
}

/** Waits until `ready()` holds, or fails saying `what`. */
export async function until(
	ready: () => boolean | Promise<boolean>,
	what: string,
	ms = 20_000,
): Promise<void> {
	const end = Date.now() + ms;
	while (!(await ready())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

/**
 * `describe` with Pebble when `BUMAIL_TEST_PEBBLE_URL` and
 * `BUMAIL_TEST_PEBBLE_CA` name one (`bun run pebble:test` starts it);
 * otherwise one skipped test saying how, or, with
 * `BUMAIL_TEST_PEBBLE_REQUIRED` set, a failure. `fetch` trusts Pebble's CA.
 */
export function describePebble(
	name: string,
	body: (pebble: { directory: string; fetch: AcmeFetch }) => void,
): void {
	if (PEBBLE_URL && PEBBLE_CA) {
		const ca = Bun.file(PEBBLE_CA).text();
		const fetchWithCa: AcmeFetch = async (input, init) =>
			await fetch(input, { ...init, tls: { ca: await ca } });
		describe(name, () => body({ directory: PEBBLE_URL, fetch: fetchWithCa }));
		return;
	}
	if (process.env['BUMAIL_TEST_PEBBLE_REQUIRED']) {
		throw new Error(
			'BUMAIL_TEST_PEBBLE_REQUIRED is set but BUMAIL_TEST_PEBBLE_URL and BUMAIL_TEST_PEBBLE_CA are not: the Pebble specs cannot run',
		);
	}
	const skipped =
		'BUMAIL_TEST_PEBBLE_URL is not set: start Pebble with `bun run pebble:test` and export the variables it prints';
	console.warn(`Pebble specs skipped: ${skipped}`);
	describe(name, () => test.skip(skipped, () => {}));
}

export interface AcmeFixture {
	readonly server: RunningServer;
	readonly dir: string;
	readonly lines: string[];
	/** The port a listener is bound to. */
	port(name: ListenerName): number;
	stop(): Promise<void>;
}

export interface AcmeSetup {
	/** The directory of an earlier fixture: its `acme/` is kept. */
	readonly dir?: string;
	readonly hostname?: string;
	readonly names?: readonly string[];
	readonly directory?: string;
	readonly acme?: AcmeOptions;
	/** The port of `http`; default free. */
	readonly http?: number;
	readonly health?: number;
	readonly signal?: AbortSignal;
}

/** The directory of an ACME server in `dir`, its mail on SQLite, seeded. */
export async function prepareAcme(setup: AcmeSetup = {}): Promise<{
	dir: string;
	file: string;
}> {
	const dir = setup.dir ?? tempDir();
	mkdirSync(dir, { recursive: true });
	const names = setup.names ?? [];
	const file = join(dir, 'bumail.toml');
	await Bun.write(
		file,
		[
			`hostname = "${setup.hostname ?? NAMES[0]}"`,
			`data = "${dir}"`,
			'[store]',
			`url = "sqlite:${dir}/mail"`,
			'[directory]',
			`url = "sqlite:${dir}/directory.sqlite"`,
			'[acme]',
			'acceptTerms = true',
			`directory = "${setup.directory ?? FAKE_DIRECTORY}"`,
			`names = [${names.map((name) => `"${name}"`).join(', ')}]`,
		].join('\n'),
	);
	if (setup.dir === undefined) await seed(dir);
	return { dir, file };
}

/** `serve` for an ACME configuration, on free ports (`http` and `health` as given), the fixture DNS. */
export function startAcme(setup: AcmeSetup = {}): {
	started: Promise<AcmeFixture>;
	lines: string[];
	dir: string;
} {
	const lines: string[] = [];
	const ready = prepareAcme(setup);
	const options: ServeOptions = {
		log: (line) => lines.push(line),
		resolver: fixtureResolver(RECORDS),
		port: (name) =>
			(name === 'http' ? setup.http : name === 'health' ? setup.health : 0) ??
			0,
		...(setup.acme === undefined ? {} : { acme: setup.acme }),
		...(setup.signal === undefined ? {} : { signal: setup.signal }),
	};
	const started = ready.then(async ({ dir, file }) => {
		const config = await readConfig({ path: file, env: {} });
		const server = await serve(config, options);
		return {
			server,
			dir,
			lines,
			port(name: ListenerName) {
				const found = server.listening.find((l) => l.name === name);
				if (found === undefined) throw new Error(`${name} is not listening`);
				return found.port;
			},
			stop: () => server.stop(),
		};
	});
	return { started, lines, dir: setup.dir ?? '' };
}

/** Each TLS listener's certificate's fingerprint, as a client sees it. */
export async function fingerprints(
	fixture: AcmeFixture,
): Promise<Record<string, string>> {
	const open: Record<string, () => Promise<Peer>> = {
		mx: () =>
			startTlsPeer(fixture.port('mx'), {
				greeting: /^220 .*\r\n/,
				command: 'EHLO peer.example\r\nSTARTTLS\r\n',
				ready: /(^|\n)220 2\.0\.0 .*\r\n/,
			}),
		submissions: () => implicitPeer(fixture.port('submissions')),
		imaps: () => implicitPeer(fixture.port('imaps')),
		https: () => implicitPeer(fixture.port('https')),
	};
	const seen: Record<string, string> = {};
	for (const [name, connect] of Object.entries(open)) {
		const peer = await connect();
		seen[name] = peer.fingerprint;
		peer.end();
	}
	return seen;
}
