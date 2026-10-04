import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BASE, writeConfig } from '../config/config.fixtures';

const MAIN = join(import.meta.dir, '..', 'main.ts');
const VERSION: string = (
	await Bun.file(join(import.meta.dir, '..', '..', 'package.json')).json()
).version;

/** Runs `bumail` as a process, with only `env` in its environment. */
async function bumail(
	args: readonly string[],
	env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([process.execPath, MAIN, ...args], {
		env: { PATH: process.env['PATH'] ?? '', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

describe('the bumail command', () => {
	test('--help prints the usage and exits 0', async () => {
		for (const flag of ['--help', '-h']) {
			const { code, out } = await bumail([flag]);
			expect(code).toBe(0);
			expect(out).toStartWith('Usage: bumail [--config <file>] <command>');
			expect(out).toContain('check-config');
		}
	});

	test('--version prints the version and exits 0', async () => {
		const { code, out } = await bumail(['--version']);
		expect(code).toBe(0);
		expect(out).toBe(`${VERSION}\n`);
	});

	test('check-config prints a summary of a valid file and exits 0', async () => {
		const path = writeConfig(
			`${BASE}[queue]\nurl = "redis://:hunter2@localhost:6379"\n`,
		);
		const { code, out, err } = await bumail(['check-config', '--config', path]);
		expect(err).toBe('');
		expect(code).toBe(0);
		expect(out).toBe(
			[
				`${path}: ok`,
				'  hostname      mail.example.com',
				'  data          /data',
				'  listening     0.0.0.0: mx 25, submissions 465, submission 587, imaps 993, https 443, http 80, health 8080 (loopback)',
				'  tls           acme',
				'  store         sqlite',
				'  queue         redis',
				'  directory     sqlite',
				'  outbound      mx',
				'  inbound dmarc enforce',
				'  jmap          https://mail.example.com',
				'  acme          mail.example.com; renewed 30 days before the end; kept in /data/acme',
				'',
			].join('\n'),
		);
	});

	test('check-config shows the ACME names, the window and the state, and leaves port 80 out of a file certificate', async () => {
		const acme = writeConfig(
			'hostname = "mail.example.com"\n[acme]\nacceptTerms = true\nnames = ["imap.example.com"]\nrenewBeforeDays = 20\ndir = "/srv/acme"\n',
		);
		const shown = await bumail(['check-config', '--config', acme]);
		expect(shown.out).toContain(
			'  acme          mail.example.com, imap.example.com; renewed 20 days before the end; kept in /srv/acme\n',
		);
		expect(shown.out).toContain('https 443, http 80, health');
		const files = writeConfig(
			'hostname = "mail.example.com"\n[tls]\nmode = "files"\ncert = "c.pem"\nkey = "k.pem"\n',
			await (async () => {
				const { selfSigned } = await import('../config/certificates.fixtures');
				const pair = await selfSigned(['mail.example.com']);
				return { 'c.pem': pair.cert, 'k.pem': pair.key };
			})(),
		);
		const plain = await bumail(['check-config', '--config', files]);
		expect(plain.out).not.toContain('http 80');
		expect(plain.out).not.toContain('  acme ');
	});

	test('check-config shows JMAP behind a proxy and the PROXY protocol, and a health check off loopback', async () => {
		const path = writeConfig(
			`${BASE}[ports]\nhttps = 8081\n[jmap]\nmode = "proxy"\norigin = "https://jmap.example.org"\ntrusted = ["10.0.0.0/8"]\n[health]\nbind = "0.0.0.0"\n[proxyProtocol]\ntrusted = ["10.0.0.1", "10.0.0.2"]\n`,
		);
		const { code, out } = await bumail(['check-config', '--config', path]);
		expect(code).toBe(0);
		expect(out).toContain('health 8080 (0.0.0.0)');
		expect(out).toContain(
			'  jmap          https://jmap.example.org (behind 1 trusted proxy, plain HTTP on 0.0.0.0:8081)\n',
		);
		expect(out).toContain(
			'  mail proxies  2 trusted proxies, PROXY protocol\n',
		);
	});

	test('check-config marks a store that sends credentials in clear', async () => {
		const path = writeConfig(
			`${BASE}[store]\nurl = "postgres://u:pw@db.internal/mail?sslmode=disable"\n[queue]\nurl = "redis://:pw@cache.internal"\ninsecure = true\n`,
		);
		const { code, out } = await bumail(['check-config', '--config', path]);
		expect(code).toBe(0);
		expect(out).toContain('  store         postgres (plaintext)\n');
		expect(out).toContain('  queue         redis (plaintext)\n');
		expect(out).not.toContain('pw');
	});

	test('check-config lists every problem of a bad file and exits 1', async () => {
		const path = writeConfig('relay = true\n');
		const { code, out, err } = await bumail([
			`--config=${path}`,
			'check-config',
		]);
		expect(code).toBe(1);
		expect(out).toBe('');
		expect(err).toBe(
			[
				`bumail: ${path}:`,
				'  relay: not an option: bumail never relays without AUTH',
				'  hostname: is required (or set BUMAIL_HOSTNAME)',
				"  acme.acceptTerms: must be true: the CA's terms of service, read and accepted",
				'',
			].join('\n'),
		);
	});

	test('reads BUMAIL_CONFIG, and the environment beats the file', async () => {
		const path = writeConfig(BASE);
		const { code, out } = await bumail(['check-config'], {
			BUMAIL_CONFIG: path,
			BUMAIL_HOSTNAME: 'mx.example.org',
		});
		expect(code).toBe(0);
		expect(out).toContain('  hostname      mx.example.org\n');
	});

	test('reads /data/bumail.toml by default', async () => {
		const { code, err } = await bumail(['check-config']);
		expect(code).toBe(1);
		expect(err).toStartWith(
			'bumail: /data/bumail.toml:\n  (file): cannot be read (',
		);
	});

	test('serve checks the file first, exiting 1 for a bad one', async () => {
		expect((await bumail(['serve', '--config', writeConfig('')])).code).toBe(1);
	});

	test.each([
		[[], 'bumail: no command given; see bumail --help'],
		[['start'], 'bumail: unknown command start; see bumail --help'],
		[
			['--verbose', 'serve'],
			'bumail: unknown option --verbose; see bumail --help',
		],
		[
			['serve', 'check-config'],
			'bumail: unexpected argument check-config; see bumail --help',
		],
		[['serve', '--config'], 'bumail: --config needs a file; see bumail --help'],
		[
			['--config=', 'serve'],
			'bumail: --config needs a file; see bumail --help',
		],
		[
			['--config', 'a', '--config', 'b', 'serve'],
			'bumail: --config is given twice; see bumail --help',
		],
	])('%p is bad usage, exiting 2', async (args, message) => {
		const { code, err } = await bumail(args);
		expect(code).toBe(2);
		expect(err).toBe(`${message}\n`);
	});
});
