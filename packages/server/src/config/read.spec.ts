import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ServerError } from '../errors';
import {
	ACME,
	BASE,
	errorOf,
	problemsOf,
	writeConfig,
	writeFiles,
} from './config.fixtures';
import { configPath, readConfig } from './read';

describe('readConfig', () => {
	test('fills in every default', async () => {
		const config = await readConfig({ path: writeConfig(BASE), env: {} });
		expect(config).toMatchObject({
			hostname: 'mail.example.com',
			data: '/data',
			bind: '0.0.0.0',
			ports: {
				mx: 25,
				submissions: 465,
				submission: 587,
				imaps: 993,
				imap: 0,
				https: 443,
				http: 80,
				health: 8080,
			},
			store: { url: 'sqlite:/data/mail' },
			queue: { url: 'sqlite:/data/queue' },
			directory: { url: 'sqlite:/data/directory.sqlite' },
			tls: { mode: 'acme' },
			acme: {
				email: 'postmaster@example.com',
				acceptTerms: true,
				directory: 'https://acme-v02.api.letsencrypt.org/directory',
			},
			smarthost: undefined,
			routes: {},
			inbound: {
				dmarc: 'enforce',
				maxMessageSize: 25 * 1024 * 1024,
				maxConnections: 1000,
			},
			submission: {
				maxMessageSize: 25 * 1024 * 1024,
				maxRecipients: 100,
				maxConnections: 1000,
			},
			jmap: { origin: 'https://mail.example.com' },
		});
	});

	test('takes what the file sets', async () => {
		const dir = writeFiles({ 'smarthost.pw': 'secret\n' });
		const config = await readConfig({
			path: writeConfig(
				`hostname = "Mail.Example.com."
data = "/srv/bumail/"
bind = "::"
[ports]
https = 8443
imap = 143
[store]
url = "postgres://bumail:pw@db.internal/mail?sslmode=verify-full"
[queue]
url = "rediss://:pw@cache.internal:6380"
[smarthost]
host = "smtp.example.net"
port = 465
username = "bumail"
passwordFile = "${join(dir, 'smarthost.pw')}"
[routes]
"Example.org" = "mx"
"example.net" = { host = "mx.example.net", port = 2525, tls = "none" }
"example.com" = "smarthost"
[inbound]
dmarc = "mark"
${ACME}`,
			),
			env: {},
		});
		expect(config.hostname).toBe('mail.example.com');
		expect(config.data).toBe('/srv/bumail');
		expect(config.bind).toBe('::');
		expect(config.ports.imap).toBe(143);
		expect(config.directory.url).toBe('sqlite:/srv/bumail/directory.sqlite');
		expect(config.smarthost).toEqual({
			host: 'smtp.example.net',
			port: 465,
			secure: true,
			tls: 'required',
			username: 'bumail',
			password: 'secret',
		});
		expect(config.routes).toEqual({
			'example.org': 'mx',
			'example.net': {
				host: 'mx.example.net',
				port: 2525,
				secure: false,
				tls: 'none',
			},
			'example.com': 'smarthost',
		});
		expect(config.inbound.dmarc).toBe('mark');
		expect(config.jmap.origin).toBe('https://mail.example.com:8443');
	});

	test('takes credentials in clear on loopback', async () => {
		const config = await readConfig({
			path: writeConfig(
				`${BASE}[store]\nurl = "postgres://bumail:pw@localhost/mail"\n[queue]\nurl = "redis://:pw@127.0.0.1:6379"\n`,
			),
			env: {},
		});
		expect(config.queue.url).toBe('redis://:pw@127.0.0.1:6379');
	});

	test('reads the path from --config, then BUMAIL_CONFIG, then /data', () => {
		expect(
			configPath({ path: '/a.toml', env: { BUMAIL_CONFIG: '/b.toml' } }),
		).toBe('/a.toml');
		expect(configPath({ env: { BUMAIL_CONFIG: '/b.toml' } })).toBe('/b.toml');
		expect(configPath({ env: {} })).toBe('/data/bumail.toml');
	});
});

describe('the environment', () => {
	test('beats the file, for each value it may set', async () => {
		const path = writeConfig(
			`hostname = "file.example.com"
[store]
url = "sqlite:/file/mail"
[queue]
url = "sqlite:/file/queue"
[smarthost]
host = "smtp.example.net"
username = "bumail"
password = "from-the-file"
${ACME}`,
		);
		const config = await readConfig({
			path,
			env: {
				BUMAIL_HOSTNAME: 'env.example.com',
				BUMAIL_STORE_URL: 'postgres://localhost/mail',
				BUMAIL_QUEUE_URL: 'redis://localhost:6379',
				BUMAIL_SMARTHOST_PASSWORD: 'from-the-env',
			},
		});
		expect(config.hostname).toBe('env.example.com');
		expect(config.store.url).toBe('postgres://localhost/mail');
		expect(config.queue.url).toBe('redis://localhost:6379');
		expect(config.smarthost?.password).toBe('from-the-env');
	});

	test('beats a passwordFile too, and reads *_FILE', async () => {
		const secrets = writeFiles({
			store: 'postgres://localhost/env\n',
			password: 'from-a-file\n',
		});
		const config = await readConfig({
			path: writeConfig(
				`${BASE}[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npasswordFile = "missing"\n`,
			),
			env: {
				BUMAIL_STORE_URL_FILE: join(secrets, 'store'),
				BUMAIL_SMARTHOST_PASSWORD_FILE: join(secrets, 'password'),
			},
		});
		expect(config.store.url).toBe('postgres://localhost/env');
		expect(config.smarthost?.password).toBe('from-a-file');
	});

	test('takes an empty variable as unset', async () => {
		const config = await readConfig({
			path: writeConfig(BASE),
			env: { BUMAIL_HOSTNAME: '', BUMAIL_STORE_URL: '' },
		});
		expect(config.hostname).toBe('mail.example.com');
		expect(config.store.url).toBe('sqlite:/data/mail');
	});

	test('is checked as the file is, and named in the problem', async () => {
		const empty = writeFiles({ empty: '\n' });
		expect(
			await problemsOf(BASE, {
				env: {
					BUMAIL_HOSTNAME: 'localhost',
					BUMAIL_STORE_URL: 'mysql://db/mail',
					BUMAIL_STORE_URL_FILE: '/x',
					BUMAIL_QUEUE_URL_FILE: join(empty, 'empty'),
					BUMAIL_SMARTHOST_PASSWORD_FILE: join(empty, 'missing'),
				},
			}),
		).toEqual([
			'BUMAIL_STORE_URL: is set with BUMAIL_STORE_URL_FILE; set one of them',
			'BUMAIL_QUEUE_URL_FILE: names an empty file',
			'BUMAIL_SMARTHOST_PASSWORD_FILE: cannot be read (ENOENT)',
			'hostname (BUMAIL_HOSTNAME): must be a fully qualified domain name, such as mail.example.com',
		]);
		expect(
			await problemsOf(BASE, {
				env: {
					BUMAIL_STORE_URL: 'mysql://db/mail',
					BUMAIL_SMARTHOST_PASSWORD: 'pw',
				},
			}),
		).toEqual([
			'store.url (BUMAIL_STORE_URL): the scheme "mysql:" is not one of sqlite:, postgres: or postgresql:',
			'BUMAIL_SMARTHOST_PASSWORD: is set, but there is no [smarthost]',
		]);
	});

	test('takes a hostname the file lacks', async () => {
		const config = await readConfig({
			path: writeConfig(ACME),
			env: { BUMAIL_HOSTNAME: 'mail.example.com' },
		});
		expect(config.hostname).toBe('mail.example.com');
	});
});

describe('no error repeats a URL or a secret', () => {
	const SECRET = 'hunter2-secret';
	const cases: [string, string, Record<string, string>][] = [
		[
			'a store URL',
			`[store]\nurl = "mysql://bumail:${SECRET}@db.internal/mail"`,
			{},
		],
		[
			'a queue URL in clear',
			`[queue]\nurl = "redis://:${SECRET}@cache.internal"`,
			{},
		],
		[
			'a PostgreSQL URL in clear',
			`[store]\nurl = "postgres://u:${SECRET}@db.internal/m"`,
			{},
		],
		['a URL with no slashes', `[store]\nurl = "${SECRET}:${SECRET}@db"`, {}],
		['a directory URL', `[directory]\nurl = "postgres://u:${SECRET}@db/d"`, {}],
		[
			'a JMAP origin',
			`[jmap]\norigin = "https://u:${SECRET}@mail.example.com"`,
			{},
		],
		[
			'a smarthost password in clear',
			`[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npassword = "${SECRET}"\ntls = "none"`,
			{},
		],
		[
			'a password of the wrong type',
			`[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npassword = ["${SECRET}"]`,
			{},
		],
		[
			'a password and a passwordFile',
			`[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npassword = "${SECRET}"\npasswordFile = "/x"`,
			{},
		],
		['an env store URL', '', { BUMAIL_STORE_URL: `mysql://u:${SECRET}@db/m` }],
		[
			'an env queue URL',
			'',
			{ BUMAIL_QUEUE_URL: `redis://:${SECRET}@cache.internal` },
		],
		[
			'an env password without a smarthost',
			'',
			{ BUMAIL_SMARTHOST_PASSWORD: SECRET },
		],
		[
			'an env password with its file',
			'',
			{
				BUMAIL_SMARTHOST_PASSWORD: SECRET,
				BUMAIL_SMARTHOST_PASSWORD_FILE: '/x',
			},
		],
	];

	test.each(cases)('%s', async (_, fragment, env) => {
		const error = await errorOf(
			`hostname = "mail.example.com"\n${fragment}\n${ACME}`,
			{ env },
		);
		expect(error).toBeInstanceOf(ServerError);
		expect(error.message).not.toContain(SECRET);
		expect(error.message).not.toContain('://');
	});

	test('nor a value TOML could not parse', async () => {
		const error = await errorOf(
			`hostname = "mail.example.com"\npassword = ${SECRET}\n`,
		);
		expect(error.message).toContain('is not TOML');
		expect(error.message).not.toContain(SECRET);
	});
});
