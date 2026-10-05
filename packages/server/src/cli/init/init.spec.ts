import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../config/config.fixtures';
import { readConfig } from '../../config/read';
import { directoryFile } from '../../directory/database';
import { Directory } from '../../directory/directory';
import { run } from '../run';

/** Runs `bumail` in-process with `argv`, in a fresh data directory. */
async function bumail(
	argv: readonly string[],
	env: Record<string, string> = {},
) {
	let out = '';
	let err = '';
	const code = await run(argv, {
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
		env,
		version: '0.0.0',
		terminal: {
			stdin: async () => '',
			isTTY: false,
			prompt: async () => '',
		},
	});
	return { code, out, err };
}

/** `[--data <dir>, --config <dir>/bumail.toml]` for a fresh directory. */
function place() {
	const data = tempDir();
	return { data, config: join(data, 'bumail.toml') };
}

const BASE = [
	'init',
	'--hostname',
	'mail.example.com',
	'--domain',
	'example.com',
];

/** Every combination of flags the guide uses. */
const VARIANTS: readonly [string, readonly string[]][] = [
	['the standalone default', []],
	['an ACME contact', ['--acme-email', 'postmaster@example.com']],
	['the staging CA', ['--acme-staging']],
	['another CA', ['--acme-directory', 'https://pebble:14000/dir']],
	[
		'staging with a contact',
		['--acme-email', 'postmaster@example.com', '--acme-staging'],
	],
	['behind Traefik', ['--behind-traefik', '--trusted-proxy', '172.18.0.0/16']],
	[
		'behind Traefik, two proxy networks',
		[
			'--behind-traefik',
			'--trusted-proxy',
			'172.18.0.0/16',
			'--trusted-proxy',
			'fd00::/8',
		],
	],
	[
		'behind a TCP proxy',
		['--proxy-protocol', '--trusted-proxy', '172.18.0.0/16'],
	],
	[
		'behind Traefik with the PROXY protocol, staging, a contact',
		[
			'--behind-traefik',
			'--proxy-protocol',
			'--trusted-proxy',
			'172.18.0.0/16',
			'--acme-staging',
			'--acme-email',
			'postmaster@example.com',
		],
	],
];

describe('bumail init', () => {
	for (const [name, flags] of VARIANTS) {
		test(`writes a configuration the loader reads, for ${name}`, async () => {
			const { data, config } = place();
			const { code, out, err } = await bumail([
				...BASE,
				...flags,
				'--data',
				data,
				'--config',
				config,
			]);
			expect(err).toBe('');
			expect(code).toBe(0);
			const loaded = await readConfig({ path: config, env: {} });
			expect(loaded.hostname).toBe('mail.example.com');
			expect(loaded.tls.mode).toBe('acme');
			expect(loaded.acme?.acceptTerms).toBe(true);
			expect(loaded.acme?.directory).toBe(
				flags.includes('--acme-staging')
					? 'https://acme-staging-v02.api.letsencrypt.org/directory'
					: flags.includes('--acme-directory')
						? 'https://pebble:14000/dir'
						: 'https://acme-v02.api.letsencrypt.org/directory',
			);
			expect(loaded.acme?.email).toBe(
				flags.includes('--acme-email') ? 'postmaster@example.com' : undefined,
			);
			expect(loaded.jmap.mode).toBe(
				flags.includes('--behind-traefik') ? 'proxy' : 'https',
			);
			expect(loaded.proxyProtocol !== undefined).toBe(
				flags.includes('--proxy-protocol'),
			);
			// The directory, the domain and its DKIM key are made.
			const directory = Directory.open({
				file: directoryFile(loaded.directory.url),
			});
			try {
				expect(directory.domains.list().map((d) => d.name)).toEqual([
					'example.com',
				]);
				expect(directory.dkim.get('example.com')?.selector).toBe('bumail');
			} finally {
				directory.close();
			}
			expect(out).toContain(`wrote ${config}\n`);
			expect(out).toContain('added the domain example.com');
			expect(out).toContain('generated an RSA-2048 DKIM key for example.com');
			expect(out).toContain('bumail user add alice@example.com');
			expect(out).toContain('bumail dns');
			// Nothing is left beside it.
			expect(
				readdirSync(data).filter((f) => f.startsWith('.bumail-init')),
			).toEqual([]);
		});
	}

	test('writes only what the server chose: no secret, no open relay', async () => {
		const { data, config } = place();
		await bumail([...BASE, '--data', data, '--config', config]);
		const text = await Bun.file(config).text();
		expect(text).toContain('hostname = "mail.example.com"');
		expect(text).toContain('acceptTerms = true');
		expect(text).not.toMatch(/relay|password|insecure|trustedNetworks/i);
		expect(statSync(config).isFile()).toBe(true);
	});

	test('writes the file readable by its owner alone', async () => {
		const { data, config } = place();
		await bumail([...BASE, '--data', data, '--config', config]);
		expect(statSync(config).mode & 0o777).toBe(0o600);
	});

	test('warns, and still writes, when a trusted proxy is not a private range', async () => {
		const { data, config } = place();
		const wide = await bumail([
			...BASE,
			'--proxy-protocol',
			'--trusted-proxy',
			'203.0.113.0/24',
			'--data',
			data,
			'--config',
			config,
		]);
		expect(wide.code).toBe(0);
		expect(wide.err).toContain(
			'warning: --trusted-proxy names a range that is not private',
		);
		const quiet = place();
		const private_ = await bumail([
			...BASE,
			'--proxy-protocol',
			'--trusted-proxy',
			'172.18.0.0/16',
			'--trusted-proxy',
			'fd00::/8',
			'--data',
			quiet.data,
			'--config',
			quiet.config,
		]);
		expect(private_.err).toBe('');
	});

	test('hosts several domains, each with its key', async () => {
		const { data, config } = place();
		const { code } = await bumail([
			...BASE,
			'--domain',
			'Example.org',
			'--domain',
			'example.com',
			'--data',
			data,
			'--config',
			config,
		]);
		expect(code).toBe(0);
		const loaded = await readConfig({ path: config, env: {} });
		const directory = Directory.open({
			file: directoryFile(loaded.directory.url),
		});
		try {
			expect(directory.domains.list().map((d) => d.name)).toEqual([
				'example.com',
				'example.org',
			]);
			expect(directory.dkim.list().map((k) => k.domain)).toEqual([
				'example.com',
				'example.org',
			]);
		} finally {
			directory.close();
		}
	});

	test('takes the file from BUMAIL_CONFIG when --config is not given', async () => {
		const { data, config } = place();
		const { code } = await bumail([...BASE, '--data', data], {
			BUMAIL_CONFIG: config,
		});
		expect(code).toBe(0);
		expect(existsSync(config)).toBe(true);
	});

	test('refuses to overwrite an existing file, and leaves it as it was', async () => {
		const { data, config } = place();
		await Bun.write(config, 'hostname = "mine.example.com"\n');
		const { code, err, out } = await bumail([
			...BASE,
			'--data',
			data,
			'--config',
			config,
		]);
		expect(code).toBe(4);
		expect(err).toBe(
			`bumail: ${config} exists; --force replaces it, and keeps the directory and its keys\n`,
		);
		expect(out).toBe('');
		expect(await Bun.file(config).text()).toBe(
			'hostname = "mine.example.com"\n',
		);
		expect(existsSync(join(data, 'directory.sqlite'))).toBe(false);
	});

	test('--force replaces the file, and keeps the domain and the key it had', async () => {
		const { data, config } = place();
		const args = [...BASE, '--data', data, '--config', config];
		await bumail(args);
		const loaded = await readConfig({ path: config, env: {} });
		const before = (() => {
			const directory = Directory.open({
				file: directoryFile(loaded.directory.url),
			});
			try {
				return directory.dkim.get('example.com')?.record;
			} finally {
				directory.close();
			}
		})();
		const again = await bumail([...args, '--acme-staging', '--force']);
		expect(again.code).toBe(0);
		expect(again.out).toContain('already');
		expect(await Bun.file(config).text()).toContain('directory = "staging"');
		const directory = Directory.open({
			file: directoryFile(loaded.directory.url),
		});
		try {
			expect(directory.dkim.get('example.com')?.record).toBe(before);
		} finally {
			directory.close();
		}
	});

	test('writes nothing when the text would not load, and names the problem', async () => {
		const { data, config } = place();
		const bad = await bumail([
			'init',
			'--hostname',
			'not a host',
			'--domain',
			'example.com',
			'--data',
			data,
			'--config',
			config,
		]);
		expect(bad.code).toBe(1);
		expect(bad.err).toContain(`bumail: ${config}:\n  hostname:`);
		expect(existsSync(config)).toBe(false);
		expect(readdirSync(data)).toEqual([]);
		const proxy = await bumail([
			...BASE,
			'--proxy-protocol',
			'--trusted-proxy',
			'0.0.0.0/0',
			'--data',
			data,
			'--config',
			config,
		]);
		expect(proxy.code).toBe(1);
		expect(proxy.err).toContain('proxyProtocol.trusted');
		expect(existsSync(config)).toBe(false);
	});

	test('refuses a domain that is not one before writing anything', async () => {
		const { data, config } = place();
		const { code, err } = await bumail([
			'init',
			'--hostname',
			'mail.example.com',
			'--domain',
			'localhost',
			'--data',
			data,
			'--config',
			config,
		]);
		expect(code).toBe(4);
		expect(err).toContain('is not a domain name');
		expect(existsSync(config)).toBe(false);
	});

	test('usage errors exit 2', async () => {
		const cases: [string[], string][] = [
			[['init', '--domain', 'example.com'], 'init needs --hostname'],
			[
				['init', '--hostname', 'mail.example.com'],
				'init needs at least one --domain',
			],
			[[...BASE, '--behind-traefik'], '--behind-traefik needs --trusted-proxy'],
			[[...BASE, '--proxy-protocol'], '--proxy-protocol needs --trusted-proxy'],
			[
				[...BASE, '--trusted-proxy', '10.0.0.0/8'],
				'--trusted-proxy needs --behind-traefik or --proxy-protocol',
			],
			[[...BASE, '--hostname', 'b.example.com'], '--hostname is given twice'],
			[[...BASE, '--acme-email'], '--acme-email needs an e-mail address'],
			[
				[
					...BASE,
					'--acme-staging',
					'--acme-directory',
					'https://ca.example/dir',
				],
				'--acme-staging and --acme-directory are both given; give one',
			],
			[[...BASE, '--frobnicate'], 'unknown option --frobnicate'],
			[[...BASE, 'extra'], 'unexpected argument extra'],
			[['health', '--force'], 'health takes no --force'],
		];
		for (const [argv, message] of cases) {
			const { code, err } = await bumail(argv);
			expect(err).toStartWith(`bumail: ${message}`);
			expect(err).toEndWith('; see bumail --help\n');
			expect(code).toBe(2);
		}
	});
});
