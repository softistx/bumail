import { expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { selfSigned } from '../config/certificates.fixtures';
import { prepare } from './serve.fixtures';
import { startTlsPeer } from './tls-peer.fixtures';

const MAIN = join(import.meta.dir, '..', 'main.ts');

/** A port free a moment ago. */
function freePort(): number {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { data() {} },
	});
	const { port } = listener;
	listener.stop(true);
	return port;
}

test('bumail serve takes a renewed certificate on SIGHUP, polling off, and still stops on SIGTERM', async () => {
	const mx = freePort();
	const { dir, file } = await prepare(
		[
			'pollSeconds = 0',
			'[ports]',
			`mx = ${mx}`,
			`submissions = ${freePort()}`,
			`submission = ${freePort()}`,
			`imaps = ${freePort()}`,
			`https = ${freePort()}`,
			`health = ${freePort()}`,
		].join('\n'),
	);
	const proc = Bun.spawn([process.execPath, MAIN, 'serve', '--config', file], {
		env: { PATH: process.env['PATH'] ?? '' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const decoder = new TextDecoder();
	const reader = proc.stdout.getReader();
	let out = '';
	const until = async (text: string) => {
		const end = Date.now() + 10_000;
		while (!out.includes(text) && Date.now() < end) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value);
		}
		if (!out.includes(text)) {
			proc.kill('SIGKILL');
			throw new Error(`no "${text}" in:\n${out}`);
		}
	};
	const peer = () =>
		startTlsPeer(mx, {
			greeting: /^220 .*\r\n/,
			command: 'EHLO peer.example\r\nSTARTTLS\r\n',
			ready: /(^|\n)220 2\.0\.0 .*\r\n/,
		});
	await until('health listening');
	const before = await peer();
	before.end();

	const renewed = await selfSigned(['mail.example.com', 'localhost']);
	await Bun.write(join(dir, 'cert.pem'), renewed.cert);
	await Bun.write(join(dir, 'key.pem'), renewed.key);
	proc.kill('SIGHUP');
	await until('tls: reloaded (CN=mail.example.com');
	const after = await peer();
	after.end();
	expect(after.fingerprint).not.toBe(before.fingerprint);
	expect(after.fingerprint).toBe(
		new X509Certificate(renewed.cert).fingerprint256,
	);
	expect(out).toContain('bumail: SIGHUP, looking for a renewed certificate\n');

	proc.kill('SIGTERM');
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	expect(await proc.exited).toBe(0);
	expect(out).toEndWith('bumail: stopped\n');
});
