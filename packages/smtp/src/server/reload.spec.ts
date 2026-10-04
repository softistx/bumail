import { afterEach, describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import { front } from './front.fixtures';
import type { SmtpServerOptions, TlsOptions } from './options';
import { v2 } from './proxy/headers.fixtures';
import {
	fingerprintOf,
	implicitPeer,
	type Peer,
	startTlsPeer,
} from './reload.fixtures';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const pair = async (name: string) => ({
	key: await fixture(`${name}.key`).text(),
	cert: await fixture(`${name}.crt`).text(),
});
const first = await pair('localhost');
const renewed = await pair('renewed');
const FIRST = fingerprintOf(first.cert);
const RENEWED = fingerprintOf(renewed.cert);

let server: SmtpServer | undefined;
const peers: Peer[] = [];
const fronts: { close(): void }[] = [];
afterEach(() => {
	for (const peer of peers.splice(0)) peer.end();
	for (const proxy of fronts.splice(0)) proxy.close();
	server?.stop(true);
	server = undefined;
});

interface Variant {
	readonly name: string;
	readonly options: Partial<SmtpServerOptions>;
	/** A new TLS connection to the server, past the handshake. */
	open(port: number): Promise<Peer>;
}

const starttls = (port: number) =>
	startTlsPeer(port, {
		greeting: /^220 .*\r\n/,
		command: 'EHLO peer.example\r\nSTARTTLS\r\n',
		ready: /(^|\n)220 2\.0\.0 .*\r\n/,
	});

const variants: Variant[] = [
	{ name: 'STARTTLS', options: {}, open: starttls },
	{
		name: 'native implicit TLS',
		options: { implicitTls: true },
		open: implicitPeer,
	},
	{
		name: 'implicit TLS behind the PROXY protocol (ProxiedTls)',
		options: {
			implicitTls: true,
			proxyProtocol: { trusted: ['127.0.0.1'] },
		},
		async open(port) {
			const proxy = await front(port, v2({ source: '198.51.100.7' }));
			fronts.push(proxy);
			return implicitPeer(proxy.port);
		},
	},
];

async function start(variant: Variant, tls: TlsOptions = first) {
	server = createSmtpServer(mxOptions({ tls, ...variant.options }));
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const open = async () => {
		const peer = await variant.open(port);
		peers.push(peer);
		return peer;
	};
	return { server, open };
}

/** What a session over `peer` says to a NOOP. */
const noop = (peer: Peer) => peer.ask('NOOP\r\n', /(^|\n)250 .*\r\n/);

describe.each(variants)('setTls: $name', (variant) => {
	test('a new connection is served the new certificate', async () => {
		const { server, open } = await start(variant);
		expect((await open()).fingerprint).toBe(FIRST);
		await server.setTls(renewed);
		expect((await open()).fingerprint).toBe(RENEWED);
		expect((await open()).fingerprint).toBe(RENEWED);
	});

	test('a session already open keeps its TLS and goes on working', async () => {
		const { server, open } = await start(variant);
		const old = await open();
		expect(await noop(old)).toContain('250');
		await server.setTls(renewed);
		expect(old.fingerprint).toBe(FIRST);
		expect(await noop(old)).toContain('250');
		expect((await open()).fingerprint).toBe(RENEWED);
	});

	test('a pair that cannot be used throws INVALID_OPTION and leaves the old one', async () => {
		const { server, open } = await start(variant);
		const bad: TlsOptions[] = [
			{ key: first.key, cert: 'not a certificate' },
			{ key: first.key, cert: renewed.cert },
			{ key: first.key, cert: fixture('missing.crt') },
		];
		for (const tls of bad) {
			const error = await server.setTls(tls).catch((cause) => cause);
			expect(error).toBeInstanceOf(SmtpError);
			expect(error).toMatchObject({ code: 'INVALID_OPTION' });
			expect(error.message).toStartWith('setTls(): tls: { key, cert }');
			expect((await open()).fingerprint).toBe(FIRST);
		}
	});

	test('a pair given as files is read once, whole', async () => {
		const { server, open } = await start(variant);
		await server.setTls({
			key: fixture('renewed.key'),
			cert: fixture('renewed.crt'),
		});
		expect((await open()).fingerprint).toBe(RENEWED);
	});

	test('a second reload replaces the first', async () => {
		const { server, open } = await start(variant);
		await server.setTls(renewed);
		await server.setTls(first);
		expect((await open()).fingerprint).toBe(FIRST);
	});
});

describe('setTls, two calls', () => {
	test('a pair with an empty key or certificate is refused, the old one kept', async () => {
		const { server, open } = await start(variants[1] as Variant);
		for (const bad of [
			{ key: first.key, cert: '' },
			{ key: '', cert: renewed.cert },
			{ key: first.key, cert: new Uint8Array() },
		]) {
			const error = await server.setTls(bad).catch((cause) => cause);
			expect(error).toMatchObject({ code: 'INVALID_OPTION' });
			expect(error.message).toContain('is empty');
			expect((await open()).fingerprint).toBe(FIRST);
		}
	});

	test('the later call wins, though the earlier one reads slower', async () => {
		const { server, open } = await start(variants[1] as Variant);
		const big = Bun.file(new URL('./fixtures/renewed.key', import.meta.url));
		// The first call reads files, the second only text, and finishes first.
		const slow = server.setTls({
			key: big,
			cert: fixture('renewed.crt'),
		});
		const fast = server.setTls(first);
		await Promise.all([slow, fast]);
		expect((await open()).fingerprint).toBe(FIRST);
		await server.setTls(renewed);
		const again = server.setTls({ key: big, cert: fixture('renewed.crt') });
		const last = server.setTls(renewed);
		await Promise.all([again, last]);
		expect((await open()).fingerprint).toBe(RENEWED);
	});
});

describe('setTls', () => {
	test('before listen(): the pair set is the one served', async () => {
		server = createSmtpServer(mxOptions({ tls: first, implicitTls: true }));
		await server.setTls(renewed);
		const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
		const peer = await implicitPeer(port);
		peers.push(peer);
		expect(peer.fingerprint).toBe(RENEWED);
	});

	test('a server made without tls has none to replace', async () => {
		server = createSmtpServer(mxOptions());
		const error = await server.setTls(renewed).catch((cause) => cause);
		expect(error).toMatchObject({ code: 'INVALID_OPTION' });
		expect(error.message).toContain('without tls');
	});

	test('a bad pair at listen() still fails it, as before', async () => {
		server = createSmtpServer(
			mxOptions({
				tls: { key: first.key, cert: 'nope' },
				implicitTls: true,
			}),
		);
		const error = await server
			.listen({ port: 0, hostname: '127.0.0.1' })
			.catch((cause) => cause);
		expect(error.message).toStartWith('listen(): tls: { key, cert }');
	});
});
