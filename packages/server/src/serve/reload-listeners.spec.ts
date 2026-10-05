import { afterEach, describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { selfSigned } from '../config/certificates.fixtures';
import type { ListenerName } from './serve';
import { type Fixture, startServer } from './serve.fixtures';
import { implicitPeer, type Peer, startTlsPeer } from './tls-peer.fixtures';

const NAMES = ['mail.example.com', 'localhost'];
const PORTS = '[ports]\nimap = 143\n';
let fixture: Fixture | undefined;
const peers: Peer[] = [];
afterEach(async () => {
	for (const peer of peers.splice(0)) peer.end();
	await fixture?.stop();
	fixture = undefined;
});

/** A TLS connection to a listener, past the handshake: from the first byte, or by its STARTTLS. */
const OPEN: Record<ListenerName, (port: number) => Promise<Peer>> = {
	mx: (port) =>
		startTlsPeer(port, {
			greeting: /^220 .*\r\n/,
			command: 'EHLO peer.example\r\nSTARTTLS\r\n',
			ready: /(^|\n)220 2\.0\.0 .*\r\n/,
		}),
	submission: (port) => OPEN.mx(port),
	imap: (port) =>
		startTlsPeer(port, {
			greeting: /^\* OK .*\r\n/,
			command: 'a1 STARTTLS\r\n',
			ready: /(^|\n)a1 OK .*\r\n/,
		}),
	submissions: implicitPeer,
	imaps: implicitPeer,
	https: implicitPeer,
	http: implicitPeer,
	health: implicitPeer,
};
const TLS: ListenerName[] = [
	'mx',
	'submissions',
	'submission',
	'imaps',
	'imap',
	'https',
];

async function served(port: ListenerName): Promise<string> {
	const peer = await OPEN[port](fixture?.port(port) ?? 0);
	peers.push(peer);
	return peer.fingerprint;
}

const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256;

describe('serve: a renewed certificate', () => {
	test('reloadTls() puts it on every TLS listener, for new connections only', async () => {
		fixture = await startServer(PORTS);
		const old = await OPEN.mx(fixture.port('mx'));
		peers.push(old);
		const first = fingerprintOf(
			await Bun.file(join(fixture.dir, 'cert.pem')).text(),
		);
		for (const name of TLS) expect(await served(name)).toBe(first);

		const renewed = await selfSigned(NAMES, {
			notAfter: new Date('2031-05-06T00:00:00Z'),
		});
		await Bun.write(join(fixture.dir, 'cert.pem'), renewed.cert);
		await Bun.write(join(fixture.dir, 'key.pem'), renewed.key);
		await fixture.server.reloadTls();

		expect(fixture.lines.at(-1)).toBe(
			'tls: reloaded (CN=mail.example.com, expires 2031-05-06)',
		);
		for (const name of TLS) {
			expect(await served(name)).toBe(fingerprintOf(renewed.cert));
		}
		// The session opened before keeps its TLS, and its server.
		expect(old.fingerprint).toBe(first);
		expect(await old.ask('NOOP\r\n', /(^|\n)250 .*\r\n/)).toContain('250');
	});

	test('a key without its certificate is refused, and the old pair stays on every listener', async () => {
		fixture = await startServer(PORTS);
		const first = fingerprintOf(
			await Bun.file(join(fixture.dir, 'cert.pem')).text(),
		);
		const renewed = await selfSigned(NAMES);
		await Bun.write(join(fixture.dir, 'key.pem'), renewed.key);
		await fixture.server.reloadTls();
		expect(fixture.lines.at(-1)).toBe(
			'tls: not reloaded: tls.key is not the key of tls.cert',
		);
		for (const name of TLS) expect(await served(name)).toBe(first);
		await Bun.write(join(fixture.dir, 'cert.pem'), renewed.cert);
		await fixture.server.reloadTls();
		expect(fixture.lines.at(-1)).toStartWith('tls: reloaded (');
		for (const name of TLS) {
			expect(await served(name)).toBe(fingerprintOf(renewed.cert));
		}
	});

	test('the files are looked at every tls.pollSeconds, with no signal', async () => {
		fixture = await startServer(`pollSeconds = 1\n${PORTS}`);
		const renewed = await selfSigned(NAMES);
		await Bun.write(join(fixture.dir, 'cert.pem'), renewed.cert);
		await Bun.write(join(fixture.dir, 'key.pem'), renewed.key);
		const end = Date.now() + 5000;
		while (
			!fixture.lines.some((line) => line.startsWith('tls: reloaded')) &&
			Date.now() < end
		) {
			await Bun.sleep(100);
		}
		expect(fixture.lines.filter((l) => l.startsWith('tls:'))).toHaveLength(1);
		for (const name of TLS) {
			expect(await served(name)).toBe(fingerprintOf(renewed.cert));
		}
	});

	test('with jmap.reloadTls = false, JMAP keeps the old certificate and the log says so', async () => {
		fixture = await startServer(`${PORTS}[jmap]\nreloadTls = false`);
		const first = await served('https');
		const renewed = await selfSigned(NAMES);
		await Bun.write(join(fixture.dir, 'cert.pem'), renewed.cert);
		await Bun.write(join(fixture.dir, 'key.pem'), renewed.key);
		await fixture.server.reloadTls();
		expect(fixture.lines.at(-1)).toEndWith(
			'; https keeps the old certificate until restart',
		);
		expect(await served('https')).toBe(first);
		expect(await served('imaps')).toBe(fingerprintOf(renewed.cert));
	});

	test('with pollSeconds = 0 only reloadTls() looks', async () => {
		fixture = await startServer(`pollSeconds = 0\n${PORTS}`);
		const renewed = await selfSigned(NAMES);
		await Bun.write(join(fixture.dir, 'cert.pem'), renewed.cert);
		await Bun.write(join(fixture.dir, 'key.pem'), renewed.key);
		await Bun.sleep(1500);
		expect(fixture.lines.filter((l) => l.startsWith('tls:'))).toEqual([]);
		await fixture.server.reloadTls();
		expect(fixture.lines.at(-1)).toStartWith('tls: reloaded (');
	});
});
