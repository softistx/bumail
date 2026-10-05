import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AcmeFetch } from '@bumail/acme';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import {
	type AcmeFixture,
	describePebble,
	fingerprints,
	freePort,
	HTTP01_PORT,
	NAMES,
	startAcme,
	until,
} from './acme.fixtures';

const DAY = 86_400_000;
const [A, B] = NAMES;

const mode = (path: string) => statSync(path).mode & 0o777;
const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256;

describePebble('tls.mode = "acme"', (pebble) => {
	setDefaultTimeout(60_000);
	/** The directory of the first issuance, which the other specs copy. */
	let issued = '';
	const fixtures: AcmeFixture[] = [];

	async function start(setup: Parameters<typeof startAcme>[0]) {
		const fixture = await startAcme({
			http: HTTP01_PORT,
			directory: pebble.directory,
			...setup,
		}).started;
		fixtures.push(fixture);
		return fixture;
	}
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.stop();
	});

	/** A new directory holding what the first issuance left on the volume. */
	function copyOfIssued(): string {
		const dir = tempDir();
		mkdirSync(join(dir, 'acme'));
		cpSync(join(issued, 'acme'), join(dir, 'acme'), { recursive: true });
		return dir;
	}

	test('obtains the first certificate at startup, with port 80 and the health check up meanwhile', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gated: AcmeFetch = async (input, init) => {
			await gate;
			return await pebble.fetch(input, init);
		};
		const health = freePort();
		const run = startAcme({
			http: HTTP01_PORT,
			health,
			directory: pebble.directory,
			names: [B],
			acme: { fetch: gated, waitingLogMs: 50, pollMs: 50 },
		});
		await until(
			() => run.lines.some((line) => line.startsWith('tls: waiting')),
			'the waiting line',
		);
		expect(run.lines).toContain(
			`tls: waiting for a certificate from ${pebble.directory}`,
		);
		const waiting = await fetch(`http://127.0.0.1:${health}/healthz`);
		expect(waiting.status).toBe(503);
		expect(await waiting.json()).toMatchObject({ tls: 'down' });
		release();
		const f = await run.started;
		fixtures.push(f);
		issued = f.dir;

		expect(run.lines.some((line) => line.startsWith('tls: obtained ('))).toBe(
			true,
		);
		const cert = readFileSync(join(f.dir, 'acme', 'cert.pem'), 'utf8');
		const leaf = new X509Certificate(cert);
		expect(leaf.checkHost(A)).toBe(A);
		expect(leaf.checkHost(B)).toBe(B);
		expect(leaf.issuer).not.toBe(leaf.subject);
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(leaf.fingerprint256),
		);
		// The health check shares a report for a second: it says up once that passes.
		await until(
			async () =>
				(await fetch(`http://127.0.0.1:${health}/healthz`)).status === 200,
			'a healthy report',
		);

		// Each challenge the CA fetched is logged once: a name has a token a
		// try (a try the network spoiled is made again, with new ones).
		const fetched = run.lines.filter((line) =>
			line.startsWith('acme: the CA fetched the challenge '),
		);
		expect(fetched.length).toBeGreaterThanOrEqual(2);
		expect(new Set(fetched).size).toBe(fetched.length);

		// Port 80 serves nothing but challenges.
		const base = `http://127.0.0.1:${HTTP01_PORT}`;
		expect(
			(await fetch(`${base}/.well-known/acme-challenge/nope`)).status,
		).toBe(404);
		expect((await fetch(`${base}/anything`)).status).toBe(404);
	});

	test('keeps its state on the volume with modes 0700 and 0600 and no temporary file left', () => {
		const dir = join(issued, 'acme');
		expect(mode(dir)).toBe(0o700);
		expect(readdirSync(dir).sort()).toEqual([
			'account.key',
			'cert.pem',
			'key.pem',
		]);
		for (const file of readdirSync(dir)) {
			expect(mode(join(dir, file))).toBe(0o600);
		}
		expect(readFileSync(join(dir, 'account.key'), 'utf8')).toStartWith(
			'-----BEGIN PRIVATE KEY-----',
		);
	});

	test('starts with the stored certificate, without waiting and without asking the CA', async () => {
		let calls = 0;
		const f = await start({
			dir: copyOfIssued(),
			names: [B],
			acme: {
				fetch: async (input, init) => {
					calls++;
					return await pebble.fetch(input, init);
				},
			},
		});
		expect(f.lines.join('\n')).toContain(
			'tls: using the stored certificate (a.bumail.test, b.bumail.test; expires ',
		);
		expect(f.lines.join('\n')).not.toContain('waiting');
		expect(calls).toBe(0);
	});

	test('renews inside the window, and every live listener switches to the new certificate together', async () => {
		const dir = copyOfIssued();
		const before = readFileSync(join(dir, 'acme', 'cert.pem'), 'utf8');
		const end = new Date(new X509Certificate(before).validTo).getTime();
		let looks = 0;
		const f = await start({
			dir,
			names: [B],
			acme: {
				fetch: pebble.fetch,
				pollMs: 50,
				checkMs: 50,
				jitterMs: 0,
				// The first look is a day from the end, inside the window of a 90-day
				// certificate and of Pebble's six-day one; later ones are now.
				now: () => (looks++ === 0 ? new Date(end - DAY) : new Date()),
			},
		});
		const accountKey = readFileSync(join(dir, 'acme', 'account.key'), 'utf8');
		const old = await fingerprints(f);
		expect(new Set(Object.values(old))).toEqual(
			new Set([fingerprintOf(before)]),
		);
		await until(
			() => f.lines.some((line) => line.startsWith('tls: renewed (')),
			'the renewal',
		);
		const after = readFileSync(join(dir, 'acme', 'cert.pem'), 'utf8');
		expect(after).not.toBe(before);
		const ends = new Date(new X509Certificate(after).validTo)
			.toISOString()
			.slice(0, 10);
		expect(f.lines).toContain(
			`tls: reloaded (DNS:${A}, DNS:${B}, expires ${ends})`,
		);
		expect(f.lines).toContain(`tls: renewed (${A}, ${B}; expires ${ends})`);
		// The account is the first issuance's: its key is reused.
		expect(readFileSync(join(dir, 'acme', 'account.key'), 'utf8')).toBe(
			accountKey,
		);
		expect(readFileSync(join(dir, 'acme', 'cert.prev.pem'), 'utf8')).toBe(
			before,
		);
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(fingerprintOf(after)),
		);
		const health = await fetch(`http://127.0.0.1:${f.port('health')}/healthz`);
		expect(await health.json()).toMatchObject({ status: 'ok', tls: 'up' });
		expect(mode(join(dir, 'acme', 'cert.pem'))).toBe(0o600);
	});

	test('a failed renewal keeps the old certificate, and a later one succeeds', async () => {
		const dir = copyOfIssued();
		const before = readFileSync(join(dir, 'acme', 'cert.pem'), 'utf8');
		const end = new Date(new X509Certificate(before).validTo).getTime();
		let down = true;
		const f = await start({
			dir,
			names: [B],
			acme: {
				fetch: async (input, init) => {
					if (down) throw new Error('the CA is unreachable');
					return await pebble.fetch(input, init);
				},
				pollMs: 50,
				checkMs: 30,
				jitterMs: 0,
				retryMs: [30],
				now: () =>
					f.lines.some((line) => line.startsWith('tls: renewed ('))
						? new Date()
						: new Date(end - DAY),
			},
		});
		await until(
			() => f.lines.some((line) => line.startsWith('tls: renewal failed: ')),
			'the failed renewal',
		);
		expect(Object.values(await fingerprints(f))).toEqual(
			Array(4).fill(fingerprintOf(before)),
		);
		expect(readFileSync(join(dir, 'acme', 'cert.pem'), 'utf8')).toBe(before);
		down = false;
		await until(
			() => f.lines.some((line) => line.startsWith('tls: renewed (')),
			'the renewal, once the CA is back',
		);
		expect(Object.values(await fingerprints(f))).not.toContain(
			fingerprintOf(before),
		);
	});

	test("exits with the CA's reason when a name does not resolve to this host", async () => {
		const run = startAcme({
			http: HTTP01_PORT,
			directory: pebble.directory,
			hostname: 'nowhere.bumail.test',
			acme: {
				fetch: pebble.fetch,
				pollMs: 50,
				startRetryMs: [50],
				waitingLogMs: 1000,
			},
		});
		const error = await run.started.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ServerError);
		expect((error as ServerError).code).toBe('UNAVAILABLE');
		expect((error as ServerError).message).toStartWith(
			`no certificate for nowhere.bumail.test from ${pebble.directory} after 2 tries: `,
		);
		expect((error as ServerError).message).toEndWith(
			'. Check that each name resolves to this host and that port 80 (ports.http) reaches it',
		);
		expect(
			run.lines.filter((line) =>
				line.startsWith('tls: obtaining a certificate failed (try '),
			),
		).toHaveLength(2);
	});
});
