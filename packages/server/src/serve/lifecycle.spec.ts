import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureResolver } from '@bumail/dns';
import { run } from '../cli/run';
import { BASE, writeConfig } from '../config/config.fixtures';
import { readConfig } from '../config/read';
import { ServerError } from '../errors';
import { serve } from './serve';
import {
	LineClient,
	mailOf,
	message,
	prepare,
	RECORDS,
	sendMail,
	startServer,
} from './serve.fixtures';

const MAIN = join(import.meta.dir, '..', 'main.ts');
const SECRET = 'smarthost-secret-never-logged';

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

async function refused(port: number): Promise<boolean> {
	try {
		const client = await LineClient.connect(port);
		client.end();
		return false;
	} catch {
		return true;
	}
}

describe('serve: starting', () => {
	test('logs one line per listener, and the ports of later slices', async () => {
		const f = await startServer();
		await f.stop();
		expect(f.lines[0]).toBe('bumail: serving mail.example.com');
		expect(f.lines[1]).toMatch(
			/^bumail: mx listening on 0\.0\.0\.0:\d+: SMTP from other servers/,
		);
		expect(f.lines[2]).toMatch(/^bumail: imaps listening on 0\.0\.0\.0:\d+: /);
		expect(f.lines.slice(3, 8)).toEqual([
			'bumail: submissions (port 465) arrives in a later slice; not listening',
			'bumail: submission (port 587) arrives in a later slice; not listening',
			'bumail: https (port 443) arrives in a later slice; not listening',
			'bumail: http (port 80) arrives in a later slice; not listening',
			'bumail: health (port 8080) arrives in a later slice; not listening',
		]);
		expect(f.lines.at(-1)).toBe('bumail: stopped');
	});

	test('logs a spool folder it had to keep, once, and starts anyway', async () => {
		const { dir, file } = await prepare();
		mkdirSync(join(dir, 'spool'), { recursive: true });
		writeFileSync(join(dir, 'spool', 'stray'), 'x');
		const config = await readConfig({ path: file, env: {} });
		const lines: string[] = [];
		const server = await serve(config, {
			log: (line) => lines.push(line),
			resolver: fixtureResolver(RECORDS),
			port: () => 0,
		});
		await server.stop();
		const kept = lines.filter((line) => line.includes('spool folder'));
		expect(kept).toHaveLength(1);
		expect(kept[0]).toStartWith(
			`bumail: the spool folder ${join(dir, 'spool', 'stray')} is kept: its age cannot be read (`,
		);
	});

	test('tls.mode "acme" fails clearly, and check-config still takes it', async () => {
		const path = writeConfig(BASE);
		const config = await readConfig({ path, env: {} });
		expect(() => serve(config)).toThrow('acme mode arrives in a later slice');
		const err: string[] = [];
		const out: string[] = [];
		const io = {
			out: (t: string) => out.push(t),
			err: (t: string) => err.push(t),
			env: {},
			version: '0.0.0',
			terminal: {
				stdin: async () => '',
				isTTY: false,
				prompt: async () => '',
			},
		};
		expect(await run(['serve', '--config', path], io)).toBe(3);
		expect(err.join('')).toContain('acme mode arrives in a later slice');
		expect(await run(['check-config', '--config', path], io)).toBe(0);
	});

	test('a port it cannot bind is UNAVAILABLE, and closes what it opened', async () => {
		const busy = Bun.listen({
			hostname: '0.0.0.0',
			port: 0,
			socket: { data() {} },
		});
		try {
			const { file } = await prepare();
			const config = await readConfig({ path: file, env: {} });
			const error = await serve(config, {
				log: () => {},
				port: (name) => (name === 'mx' ? 0 : busy.port),
			}).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ServerError);
			expect((error as ServerError).code).toBe('UNAVAILABLE');
			expect((error as ServerError).message).toMatch(
				/^imaps cannot listen on 0\.0\.0\.0:\d+ \(.*EADDRINUSE\)$/,
			);
			// The store was closed: a second server opens it.
			const again = await serve(config, { log: () => {}, port: () => 0 });
			await again.stop();
		} finally {
			busy.stop(true);
		}
	});
});

describe('serve: stopping', () => {
	test('stops accepting, lets a message under way finish, then closes the store', async () => {
		const f = await startServer();
		const port = f.port('mx');
		const client = await LineClient.connect(port);
		await client.reply();
		await client.smtp('EHLO client.example');
		await client.smtp('MAIL FROM:<joe@pass.example>');
		await client.smtp('RCPT TO:<alice@example.com>');
		await client.smtp('DATA');
		const text = message('joe@pass.example', 'mid-stop');
		client.write(text.slice(0, 40));

		const stopping = f.server.stop();
		await Bun.sleep(100);
		expect(await refused(port)).toBe(true);
		client.write(`${text.slice(40)}\r\n.\r\n`);
		expect(await client.reply()).toStartWith('250 ');
		await client.smtp('QUIT');
		await stopping;
		expect(f.lines.at(-1)).toBe('bumail: stopped');
		expect(await mailOf(f.dir, 'alice@example.com', 'inbox')).toHaveLength(1);
	});

	test('hangs up on SMTP sessions still open after drainSeconds, and closes IMAP at once', async () => {
		const f = await startServer('', { drainSeconds: 0.3 });
		const smtp = await LineClient.connect(f.port('mx'));
		await smtp.reply();
		const imap = await LineClient.connect(f.port('imaps'), true);
		await imap.until(/^\* OK[^\n]*\n/);
		const started = Date.now();
		await f.server.stop();
		expect(Date.now() - started).toBeLessThan(3000);
		// @bumail/smtp's stop(true) hangs up without a 421.
		expect(await smtp.reply()).toBe('');
		expect(smtp.closed).toBe(true);
		await imap.until(/(?!)/, 2);
		expect(imap.closed).toBe(true);
	});

	test('force skips the drain, a session still open', async () => {
		const f = await startServer('', { drainSeconds: 30 });
		const smtp = await LineClient.connect(f.port('mx'));
		await smtp.reply();
		const stopping = f.server.stop();
		await Bun.sleep(100);
		const started = Date.now();
		await f.server.stop({ force: true });
		await stopping;
		expect(Date.now() - started).toBeLessThan(2000);
		await smtp.until(/(?!)/, 2);
		expect(smtp.closed).toBe(true);
	});

	test('leaves the spool empty after a delivery and a refusal', async () => {
		const f = await startServer();
		await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'kept'),
		);
		await sendMail(
			f.port('mx'),
			{ from: 'joe@reject.example', to: ['alice@example.com'] },
			message('joe@reject.example', 'refused'),
		);
		const [name] = readdirSync(join(f.dir, 'spool'));
		expect(name).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}$`));
		const spool = join(f.dir, 'spool', name ?? '');
		expect(statSync(spool).mode & 0o777).toBe(0o700);
		expect(readdirSync(spool)).toEqual(['owner']);
		await f.stop();
		// The stop removes the folder.
		expect(readdirSync(join(f.dir, 'spool'))).toEqual([]);
	});

	test('answers 452 4.3.1 to MAIL FROM while the spool is full, and takes mail again after', async () => {
		const f = await startServer(
			'[inbound]\nmaxMessageSize = 4000\nspoolBytes = 6000',
		);
		const held = await LineClient.connect(f.port('mx'));
		await held.reply();
		await held.smtp('EHLO client.example');
		await held.smtp('MAIL FROM:<joe@pass.example>');
		await held.smtp('RCPT TO:<alice@example.com>');
		await held.smtp('DATA');
		held.write(`X-Filler: ${'a'.repeat(2500)}\r\n`);
		await Bun.sleep(200);
		const { replies } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'no room'),
		);
		// The greeting, EHLO, then MAIL FROM.
		expect(replies[2]).toStartWith('452 4.3.1 Insufficient system storage');
		held.write(`${message('joe@pass.example', 'held')}\r\n.\r\n`);
		expect(await held.reply()).toStartWith('250 ');
		await held.smtp('QUIT');
		held.end();
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'room again'),
		);
		expect(last).toStartWith('250 ');
		await f.stop();
	});

	test('answers 452 4.3.1 at the end of DATA when the spool filled during it, and keeps nothing of it', async () => {
		const f = await startServer(
			'[inbound]\nmaxMessageSize = 4000\nspoolBytes = 6000',
		);
		// Both pass MAIL FROM while the spool is empty.
		const first = await LineClient.connect(f.port('mx'));
		const second = await LineClient.connect(f.port('mx'));
		for (const client of [first, second]) {
			await client.reply();
			await client.smtp('EHLO client.example');
			await client.smtp('MAIL FROM:<joe@pass.example>');
			await client.smtp('RCPT TO:<alice@example.com>');
			await client.smtp('DATA');
		}
		first.write(`X-Filler: ${'a'.repeat(3000)}\r\n`);
		await Bun.sleep(200);
		second.write(
			`X-Filler: ${'b'.repeat(3000)}\r\n${message('joe@pass.example', 'no room')}\r\n.\r\n`,
		);
		expect(await second.reply()).toStartWith(
			'452 4.3.1 Insufficient system storage',
		);
		first.write(`${message('joe@pass.example', 'first')}\r\n.\r\n`);
		expect(await first.reply()).toStartWith('250 ');
		for (const client of [first, second]) {
			await client.smtp('QUIT');
			client.end();
		}
		await f.stop();
		const inbox = await mailOf(f.dir, 'alice@example.com', 'inbox');
		expect(inbox).toHaveLength(1);
		expect(inbox[0]).toContain('Subject: first');
		expect(f.lines).toContainEqual(
			expect.stringContaining('deferred: the spool is full'),
		);
	});

	test('bumail serve stops on SIGTERM, exits 0, and logs no secret', async () => {
		const mx = freePort();
		const imaps = freePort();
		const { file } = await prepare(
			[
				'[ports]',
				`mx = ${mx}`,
				`imaps = ${imaps}`,
				'[smarthost]',
				'host = "smtp.example.net"',
				'username = "relay-user"',
				`password = "${SECRET}"`,
			].join('\n'),
		);
		const proc = Bun.spawn(
			[process.execPath, MAIN, 'serve', '--config', file],
			{
				env: { PATH: process.env['PATH'] ?? '' },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const decoder = new TextDecoder();
		let out = '';
		const reader = proc.stdout.getReader();
		const end = Date.now() + 10_000;
		while (!out.includes('imaps listening') && Date.now() < end) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value);
		}
		expect(out).toContain(`mx listening on 0.0.0.0:${mx}`);
		const client = await LineClient.connect(mx);
		expect(await client.reply()).toStartWith('220 mail.example.com');
		client.end();
		proc.kill('SIGTERM');
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value);
		}
		const err = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(0);
		expect(out).toContain('bumail: SIGTERM, stopping\n');
		expect(out).toEndWith('bumail: stopped\n');
		expect(`${out}${err}`).not.toContain(SECRET);
	});
});
