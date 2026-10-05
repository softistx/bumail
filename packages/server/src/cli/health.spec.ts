import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tempDir } from '../config/config.fixtures';
import { run } from './run';

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

async function config(port: number, extra = ''): Promise<string> {
	const dir = tempDir();
	const path = join(dir, 'bumail.toml');
	await Bun.write(
		path,
		`hostname = "mail.example.com"\ndata = "${dir}"\n[ports]\nhealth = ${port}\n[acme]\nacceptTerms = true\n${extra}`,
	);
	return path;
}

async function health(path: string) {
	let out = '';
	let err = '';
	const code = await run(['health', '--config', path], {
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
		env: {},
		version: '0.0.0',
		terminal: { stdin: async () => '', isTTY: false, prompt: async () => '' },
	});
	return { code, out, err };
}

describe('bumail health', () => {
	test('exits 0 and says ok when /healthz answers 200', async () => {
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: (request) =>
				new URL(request.url).pathname === '/healthz'
					? Response.json({ status: 'ok' })
					: new Response('no', { status: 404 }),
		});
		servers.push(server);
		const { code, out, err } = await health(await config(server.port ?? 0));
		expect({ code, out, err }).toEqual({ code: 0, out: 'ok\n', err: '' });
	});

	test('exits 1 with the check’s answer when it says 503', async () => {
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () =>
				Response.json(
					{ status: 'unavailable', store: 'failed' },
					{ status: 503 },
				),
		});
		servers.push(server);
		const { code, out, err } = await health(await config(server.port ?? 0));
		expect(code).toBe(1);
		expect(out).toBe('');
		expect(err).toBe(
			'bumail: unhealthy: 503 {"status":"unavailable","store":"failed"}\n',
		);
	});

	test('exits 1 when nothing answers', async () => {
		const probe = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(''),
		});
		const port = probe.port ?? 0;
		probe.stop(true);
		const { code, err } = await health(await config(port));
		expect(code).toBe(1);
		expect(err).toContain('did not answer; is bumail serve running?');
	});

	test('exits 5 when the health check is turned off, and 1 for a bad file', async () => {
		const off = await health(await config(0));
		expect(off.code).toBe(5);
		expect(off.err).toBe(
			'bumail: the health check is turned off (ports.health = 0)\n',
		);
		const bad = await health(join(tempDir(), 'missing.toml'));
		expect(bad.code).toBe(1);
	});
});

describe('bumail health --tls-pending', () => {
	const waiting = {
		status: 'unavailable',
		listeners: { mx: 'down', http: 'up' },
		tls: 'down',
		directory: 'ok',
		store: 'ok',
	};

	async function ask(body: unknown, status: number, flag: boolean) {
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => Response.json(body, { status }),
		});
		servers.push(server);
		const path = await config(server.port ?? 0);
		let out = '';
		let err = '';
		const code = await run(
			['health', '--config', path, ...(flag ? ['--tls-pending'] : [])],
			{
				out: (text) => {
					out += text;
				},
				err: (text) => {
					err += text;
				},
				env: {},
				version: '0.0.0',
				terminal: {
					stdin: async () => '',
					isTTY: false,
					prompt: async () => '',
				},
			},
		);
		return { code, out, err };
	}

	test('takes a server waiting for its certificate as well, and only with the flag', async () => {
		expect(await ask(waiting, 503, true)).toEqual({
			code: 0,
			out: 'ok (waiting for a certificate)\n',
			err: '',
		});
		expect((await ask(waiting, 503, false)).code).toBe(1);
	});

	test('does not take a server whose store failed, or whose challenge listener is down', async () => {
		expect((await ask({ ...waiting, store: 'failed' }, 503, true)).code).toBe(
			1,
		);
		expect(
			(await ask({ ...waiting, listeners: { http: 'down' } }, 503, true)).code,
		).toBe(1);
		expect((await ask({ ...waiting, tls: 'up' }, 503, true)).code).toBe(1);
		expect((await ask('not a report', 503, true)).code).toBe(1);
	});
});
