import { afterEach, describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AcmeFetch } from '@bumail/acme';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import {
	type AcmeFixture,
	type AcmeSetup,
	fingerprints,
	freePort,
	NAMES,
	startAcme,
	until,
} from './acme.fixtures';

const DAY = 86_400_000;
const [A, B] = NAMES;

let fixture: AcmeFixture | undefined;
afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
});

/** A `fetch` for the CA that counts its calls and always fails. */
function refusing(): { fetch: AcmeFetch; calls: () => number } {
	let calls = 0;
	return {
		fetch: async () => {
			calls++;
			throw new Error('the CA is down');
		},
		calls: () => calls,
	};
}

/** A directory with a pair stored under `acme/`, as an earlier run left it. */
async function stored(
	names: readonly string[],
	validity: { notBefore?: Date; notAfter?: Date } = {},
): Promise<{ dir: string; pair: { cert: string; key: string } }> {
	const dir = tempDir();
	const pair = await selfSigned(names, validity);
	mkdirSync(join(dir, 'acme'));
	writeFileSync(join(dir, 'acme', 'cert.pem'), pair.cert);
	writeFileSync(join(dir, 'acme', 'key.pem'), pair.key);
	return { dir, pair };
}

async function start(setup: AcmeSetup): Promise<AcmeFixture> {
	fixture = await startAcme(setup).started;
	return fixture;
}

const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256;

describe('tls.mode = "acme": a stored certificate', () => {
	test('serves with it at once on every TLS listener, never asking the CA, and port 80 answers only challenges', async () => {
		const { dir, pair } = await stored([A]);
		const ca = refusing();
		const f = await start({
			dir,
			http: freePort(),
			acme: { fetch: ca.fetch },
		});
		expect(f.lines.join('\n')).toContain(
			'tls: using the stored certificate (a.bumail.test; expires ',
		);
		expect(f.lines.join('\n')).not.toContain('waiting');
		const seen = await fingerprints(f);
		expect(Object.values(seen)).toEqual(
			Array(4).fill(fingerprintOf(pair.cert)),
		);
		const base = `http://127.0.0.1:${f.port('http')}`;
		const home = await fetch(`${base}/`, { redirect: 'manual' });
		expect(home.status).toBe(301);
		expect(home.headers.get('location')).toBe('https://a.bumail.test/');
		const health = await fetch(`http://127.0.0.1:${f.port('health')}/healthz`);
		expect(await health.json()).toMatchObject({ status: 'ok', tls: 'up' });
		expect(ca.calls()).toBe(0);
	});

	test('a certificate for other names is not used: the server waits for one, and exits when none comes', async () => {
		const { dir } = await stored(['other.bumail.test']);
		const ca = refusing();
		const http = freePort();
		const run = startAcme({
			dir,
			http,
			acme: { fetch: ca.fetch, startRetryMs: [10, 10], waitingLogMs: 1000 },
		});
		const error = await run.started.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ServerError);
		expect((error as ServerError).code).toBe('UNAVAILABLE');
		expect((error as ServerError).message).toBe(
			'no certificate for a.bumail.test from https://ca.example.invalid/dir after 3 tries: newAccount(): fetch failed: the CA is down. Check that each name resolves to this host and that port 80 (ports.http) reaches it',
		);
		expect(run.lines).toContain(
			'tls: the stored certificate is not used: it does not name a.bumail.test',
		);
		expect(run.lines).toContain(
			'tls: obtaining a certificate failed (try 3 of 3): newAccount(): fetch failed: the CA is down',
		);
		expect(ca.calls()).toBeGreaterThanOrEqual(3);
		// Everything it started is stopped again: the port is free.
		Bun.listen({
			hostname: '0.0.0.0',
			port: http,
			socket: { data() {} },
		}).stop(true);
	});

	test('an expired certificate is not used either', async () => {
		const { dir } = await stored([A], {
			notBefore: new Date(Date.now() - 3 * DAY),
			notAfter: new Date(Date.now() - DAY),
		});
		const run = startAcme({
			dir,
			acme: { fetch: refusing().fetch, startRetryMs: [], waitingLogMs: 1000 },
		});
		await run.started.catch(() => {});
		expect(run.lines).toContain(
			'tls: the stored certificate is not used: expired',
		);
	});
});

describe('tls.mode = "acme": waiting for a first certificate', () => {
	test('port 80 and the health check are up, the health check says tls: down, the log says it is waiting, and a signal ends the wait', async () => {
		const dir = tempDir();
		const abort = new AbortController();
		const health = freePort();
		const http = freePort();
		const hold = new Promise<never>(() => {});
		const run = startAcme({
			dir,
			http,
			health,
			signal: abort.signal,
			acme: { fetch: () => hold, waitingLogMs: 20 },
		});
		const waiting =
			'tls: waiting for a certificate from https://ca.example.invalid/dir';
		await until(
			() => run.lines.filter((line) => line === waiting).length >= 3,
			'the waiting lines',
		);
		const report = await fetch(`http://127.0.0.1:${health}/healthz`);
		expect(report.status).toBe(503);
		expect(await report.json()).toMatchObject({
			status: 'unavailable',
			tls: 'down',
			listeners: { mx: 'down', https: 'down', http: 'up' },
		});
		const home = await fetch(`http://127.0.0.1:${http}/`, {
			redirect: 'manual',
		});
		expect(home.status).toBe(301);
		abort.abort();
		const error = await run.started.catch((e: unknown) => e);
		expect((error as ServerError).message).toBe(
			'stopped while waiting for a certificate',
		);
		await expect(fetch(`http://127.0.0.1:${http}/`)).rejects.toThrow();
	});
});

describe('tls.mode = "acme": SIGHUP', () => {
	test('reads the stored pair and never renews', async () => {
		const { dir, pair } = await stored([A]);
		const ca = refusing();
		const f = await start({ dir, acme: { fetch: ca.fetch } });
		await f.server.reloadTls();
		expect(f.lines.at(-1)).toStartWith('tls: unchanged (');
		const renewed = await selfSigned([A]);
		writeFileSync(join(dir, 'acme', 'cert.pem'), renewed.cert);
		writeFileSync(join(dir, 'acme', 'key.pem'), renewed.key);
		await f.server.reloadTls();
		expect(f.lines.at(-1)).toStartWith('tls: reloaded (CN=a.bumail.test');
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(fingerprintOf(renewed.cert)),
		);
		// A pair that is not a pair keeps the one in use.
		writeFileSync(join(dir, 'acme', 'key.pem'), pair.key);
		await f.server.reloadTls();
		expect(f.lines.at(-1)).toBe(
			`tls: not reloaded: ${dir}/acme/key.pem is not the key of ${dir}/acme/cert.pem`,
		);
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(fingerprintOf(renewed.cert)),
		);
		expect(ca.calls()).toBe(0);
	});
});

describe('tls.mode = "acme": the renewal window', () => {
	test('a certificate with time left is not renewed', async () => {
		const { dir } = await stored([A], {
			notBefore: new Date(Date.now() - 30 * DAY),
			notAfter: new Date(Date.now() + 60 * DAY),
		});
		const ca = refusing();
		await start({ dir, acme: { fetch: ca.fetch, checkMs: 20, jitterMs: 0 } });
		await Bun.sleep(300);
		expect(ca.calls()).toBe(0);
	});

	test('one inside it is renewed, and a failure keeps the old certificate and is retried with backoff', async () => {
		const { dir, pair } = await stored([A], {
			notBefore: new Date(Date.now() - 70 * DAY),
			notAfter: new Date(Date.now() + 20 * DAY),
		});
		const ca = refusing();
		const f = await start({
			dir,
			acme: { fetch: ca.fetch, checkMs: 20, jitterMs: 0, retryMs: [30, 60] },
		});
		const failed = () =>
			f.lines.filter((line) => line.startsWith('tls: renewal failed: '));
		await until(() => failed().length >= 3, 'three failed renewals');
		expect(failed()[0]).toBe(
			'tls: renewal failed: newAccount(): fetch failed: the CA is down; the current certificate stays, trying again in 1 s',
		);
		expect(ca.calls()).toBeGreaterThanOrEqual(3);
		expect(f.lines.some((line) => line.startsWith('tls: renewed'))).toBe(false);
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(fingerprintOf(pair.cert)),
		);
		expect(readFileSync(join(dir, 'acme', 'cert.pem'), 'utf8')).toBe(pair.cert);
		expect(readFileSync(join(dir, 'acme', 'key.pem'), 'utf8')).toBe(pair.key);
		expect(statSync(join(dir, 'acme', 'cert.pem')).isFile()).toBe(true);
	});
});

describe('tls.mode = "acme": a crash between the two renames of a renewal', () => {
	test('a pair that is not one falls back to the previous pair, and puts it back', async () => {
		const { dir, pair: previous } = await stored([A]);
		const other = await selfSigned([A]);
		const state = join(dir, 'acme');
		writeFileSync(join(state, 'cert.prev.pem'), previous.cert);
		writeFileSync(join(state, 'key.prev.pem'), previous.key);
		// The new certificate was renamed in, its key not yet.
		writeFileSync(join(state, 'cert.pem'), other.cert);
		const f = await start({ dir, acme: { fetch: refusing().fetch } });
		expect(f.lines).toContain(
			"tls: the stored certificate is not used: the key is not the certificate's; using the previous pair",
		);
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(fingerprintOf(previous.cert)),
		);
		expect(readFileSync(join(state, 'cert.pem'), 'utf8')).toBe(previous.cert);
		expect(readFileSync(join(state, 'key.pem'), 'utf8')).toBe(previous.key);
	});
});

describe('tls.mode = "acme": a previous pair that cannot be used', () => {
	/** Starts with no current pair and the previous files `plant` writes; answers the log. */
	async function refused(
		plant: (state: string) => Promise<void>,
	): Promise<string[]> {
		const dir = tempDir();
		const state = join(dir, 'acme');
		mkdirSync(state);
		await plant(state);
		const run = startAcme({
			dir,
			acme: { fetch: refusing().fetch, startRetryMs: [], waitingLogMs: 1000 },
		});
		await run.started.catch(() => {});
		expect(readdirSync(state).sort()).not.toContain('cert.pem');
		return run.lines;
	}

	const plantPrevious = (
		state: string,
		pair: { cert: string; key: string },
	): void => {
		writeFileSync(join(state, 'cert.prev.pem'), pair.cert);
		writeFileSync(join(state, 'key.prev.pem'), pair.key);
	};

	test('an expired one is refused', async () => {
		const lines = await refused(async (state) =>
			plantPrevious(
				state,
				await selfSigned([A], {
					notBefore: new Date(Date.now() - 3 * DAY),
					notAfter: new Date(Date.now() - DAY),
				}),
			),
		);
		expect(lines.some((line) => line.endsWith('using the previous pair'))).toBe(
			false,
		);
		expect(lines.some((line) => line.startsWith('tls: no certificate'))).toBe(
			true,
		);
	});

	test('one that names another host is refused', async () => {
		const lines = await refused(async (state) =>
			plantPrevious(state, await selfSigned(['other.bumail.test'])),
		);
		expect(lines.some((line) => line.endsWith('using the previous pair'))).toBe(
			false,
		);
	});

	test('one with a file missing is refused', async () => {
		const lines = await refused(async (state) => {
			const pair = await selfSigned([A]);
			writeFileSync(join(state, 'cert.prev.pem'), pair.cert);
		});
		expect(lines.some((line) => line.endsWith('using the previous pair'))).toBe(
			false,
		);
	});
});

describe('tls.mode = "acme": SIGHUP checks every name', () => {
	test('a pair that lacks one of acme.names is refused, naming the acme files', async () => {
		const { dir } = await stored([A, B]);
		const f = await start({
			dir,
			names: [B],
			acme: { fetch: refusing().fetch },
		});
		const narrow = await selfSigned([A]);
		writeFileSync(join(dir, 'acme', 'cert.pem'), narrow.cert);
		writeFileSync(join(dir, 'acme', 'key.pem'), narrow.key);
		await f.server.reloadTls();
		expect(f.lines.at(-1)).toBe(
			`tls: not reloaded: ${dir}/acme/cert.pem does not name ${B}`,
		);
	});
});

/** A CA that is rate limiting: every request answers 429 with this `Retry-After`, and notes when it was asked. */
function limiting(retryAfter: number): { fetch: AcmeFetch; at: number[] } {
	const at: number[] = [];
	return {
		at,
		fetch: async () => {
			at.push(Date.now());
			return new Response(
				JSON.stringify({
					type: 'urn:ietf:params:acme:error:rateLimited',
					detail: 'too many new orders',
				}),
				{
					status: 429,
					headers: {
						'content-type': 'application/problem+json',
						'retry-after': String(retryAfter),
					},
				},
			);
		},
	};
}

describe('tls.mode = "acme": the CA rate limits', () => {
	test('a Retry-After longer than every wait left ends the first start at once, naming the wait', async () => {
		const ca = limiting(120);
		const run = startAcme({
			dir: (await stored(['other.bumail.test'])).dir,
			acme: { fetch: ca.fetch, startRetryMs: [10, 10], waitingLogMs: 1000 },
		});
		const error = await run.started.catch((e: unknown) => e);
		expect((error as ServerError).code).toBe('UNAVAILABLE');
		expect((error as ServerError).message).toStartWith(
			'no certificate for a.bumail.test from https://ca.example.invalid/dir: the CA is rate limiting and asks to wait 2 min before another try, longer than the 1 s the tries left would wait: ',
		);
		expect((error as ServerError).message).toEndWith(
			'. Start the server again after that',
		);
		expect(ca.at).toHaveLength(1);
	});

	test('a shorter Retry-After lengthens the wait to it', async () => {
		const ca = limiting(1);
		const run = startAcme({
			dir: (await stored(['other.bumail.test'])).dir,
			acme: { fetch: ca.fetch, startRetryMs: [10, 10_000], waitingLogMs: 1000 },
		});
		const outcome = await Promise.race([
			run.started.catch(() => 'ended'),
			until(() => ca.at.length >= 2, 'a second try').then(() => 'tried'),
		]);
		expect(outcome).toBe('tried');
		expect((ca.at[1] ?? 0) - (ca.at[0] ?? 0)).toBeGreaterThanOrEqual(950);
	});
});
