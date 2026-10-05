import { describe, expect, test } from 'bun:test';
import { ACME, BASE, problemsOf } from './config.fixtures';

/**
 * Every problem `readConfig` reports, by its exact `path: problem` line,
 * each the heading of an entry in docs/troubleshooting.md.
 */
describe('the problems of a configuration', () => {
	test.each<[string, string, string[]]>([
		[
			'a key no section has',
			'hostnme = "x"',
			['hostnme: unknown key; did you mean "hostname"?'],
		],
		['a key like none', 'colour = "x"', ['colour: unknown key']],
		[
			'snake_case',
			'[inbound]\nmax_connections = 5',
			['inbound.max_connections: unknown key; did you mean "maxConnections"?'],
		],
		[
			'relay',
			'relay = true',
			['relay: not an option: bumail never relays without AUTH'],
		],
		[
			'mynetworks',
			'[inbound]\nmynetworks = ["10.0.0.0/8"]',
			['inbound.mynetworks: not an option: bumail never relays without AUTH'],
		],
		[
			'trustedNetworks',
			'[submission]\ntrustedNetworks = ["10.0.0.0/8"]',
			[
				'submission.trustedNetworks: not an option: bumail never relays without AUTH',
			],
		],
		[
			'a postmaster that is no address',
			'postmaster = "postmaster"',
			['postmaster: must be an e-mail address, such as postmaster@example.com'],
		],
		[
			'a per-client cap of 0',
			'[inbound]\nmaxConnectionsPerClient = 0',
			['inbound.maxConnectionsPerClient: must be an integer from 1 to 100000'],
		],
		[
			'a handshake timeout out of range',
			'[submission]\nhandshakeTimeout = 0',
			['submission.handshakeTimeout: must be an integer from 1 to 300'],
		],
		[
			'a section that is not a table',
			'ports = 25',
			['ports: must be a table, not an integer'],
		],
		[
			'a string that is not',
			'data = 1.5',
			['data: must be a string, not a number'],
		],
		[
			'a boolean that is not',
			'[smarthost]\nhost = "smtp.example.net"\nsecure = "yes"',
			['smarthost.secure: must be true or false, not a string'],
		],
		['a date', 'bind = 1979-05-27', ['bind: must be a string, not a date']],
		[
			'a port out of range',
			'[ports]\nmx = 70000',
			['ports.mx: must be an integer from 0 to 65535'],
		],
		[
			'a port twice',
			'[ports]\nsubmission = 465',
			['ports.submission: 465 is also ports.submissions'],
		],
		[
			'the health port on a public one',
			'[ports]\nhealth = 993',
			['ports.health: 993 is also ports.imaps'],
		],
		[
			'a choice',
			'[inbound]\ndmarc = "reject"',
			['inbound.dmarc: must be "enforce" or "mark"'],
		],
		[
			'a spool smaller than a message',
			'[inbound]\nmaxMessageSize = 4000\nspoolBytes = 3999',
			['inbound.spoolBytes: must be at least inbound.maxMessageSize (4000)'],
		],
		[
			'a spool size that is not an integer',
			'[inbound]\nspoolBytes = 1.5',
			['inbound.spoolBytes: must be an integer from 1 to 1099511627776'],
		],
		[
			'a size',
			'[submission]\nmaxMessageSize = 0',
			['submission.maxMessageSize: must be an integer from 1 to 1073741824'],
		],
		[
			'recipients',
			'[submission]\nmaxRecipients = 0',
			['submission.maxRecipients: must be an integer from 1 to 10000'],
		],
		[
			'connections',
			'[inbound]\nmaxConnections = 0',
			['inbound.maxConnections: must be an integer from 1 to 100000'],
		],
		['a relative data', 'data = "data"', ['data: must be an absolute path']],
		[
			'a bind that is a name',
			'bind = "localhost"',
			['bind: must be an IPv4 or IPv6 address'],
		],
		[
			'a store that is no URL',
			'[store]\nurl = "not a url"',
			['store.url: is not a URL'],
		],
		[
			'a store scheme',
			'[store]\nurl = "mysql://db/mail"',
			[
				'store.url: the scheme "mysql:" is not one of sqlite:, postgres: or postgresql:',
			],
		],
		[
			'a queue scheme',
			'[queue]\nurl = "mongodb://db/queue"',
			[
				'queue.url: the scheme "mongodb:" is not one of sqlite:, postgres:, postgresql:, redis: or rediss:',
			],
		],
		[
			'a directory scheme',
			'[directory]\nurl = "postgres://db/dir"',
			['directory.url: the scheme "postgres:" is not one of sqlite:'],
		],
		[
			'a sqlite host',
			'[store]\nurl = "sqlite://data/mail"',
			[
				'store.url: must be sqlite: and an absolute path, such as sqlite:/data/mail',
			],
		],
		[
			'a relative sqlite path',
			'[queue]\nurl = "sqlite:queue"',
			[
				'queue.url: must be sqlite: and an absolute path, such as sqlite:/data/mail',
			],
		],
		[
			'Redis credentials in clear',
			'[queue]\nurl = "redis://:pw@cache.internal:6379"',
			[
				'queue.url: sends credentials without TLS; use rediss:, or set insecure = true to send them in clear',
			],
		],
		[
			'PostgreSQL credentials in clear',
			'[store]\nurl = "postgres://bumail:pw@db.internal/mail"',
			[
				'store.url: sends credentials without TLS; add sslmode=require (or verify-ca, verify-full), or sslmode=disable to send them in clear',
			],
		],
		[
			'PostgreSQL with sslmode=prefer',
			'[queue]\nurl = "postgres://bumail:pw@db.internal/mail?sslmode=prefer"',
			[
				'queue.url: sends credentials without TLS; add sslmode=require (or verify-ca, verify-full), or sslmode=disable to send them in clear',
			],
		],
		[
			'an origin over http',
			'[jmap]\norigin = "http://mail.example.com"',
			['jmap.origin: the scheme "http:" is not https:'],
		],
		[
			'an origin with a path',
			'[jmap]\norigin = "https://mail.example.com/jmap"',
			[
				'jmap.origin: must be an origin, with no path or query, such as https://mail.example.com',
			],
		],
		[
			'an origin with credentials',
			'[jmap]\norigin = "https://u:pw@mail.example.com"',
			['jmap.origin: must not hold credentials'],
		],
		[
			'a smarthost with no host',
			'[smarthost]\nport = 587',
			['smarthost.host: is required'],
		],
		[
			'a smarthost host that is none',
			'[smarthost]\nhost = "smtp example"',
			['smarthost.host: must be a host name or an IP address'],
		],
		[
			'a username alone',
			'[smarthost]\nhost = "smtp.example.net"\nusername = "bumail"',
			['smarthost.username: needs a password or a passwordFile'],
		],
		[
			'a password alone',
			'[smarthost]\nhost = "smtp.example.net"\npassword = "pw"',
			['smarthost.password: needs a username'],
		],
		[
			'both password and passwordFile',
			'[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npassword = "pw"\npasswordFile = "pw.txt"',
			['smarthost.password: is given with passwordFile; give one of them'],
		],
		[
			'an unreadable passwordFile',
			'[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npasswordFile = "missing.txt"',
			['smarthost.passwordFile: cannot be read (ENOENT)'],
		],
		[
			'credentials over opportunistic TLS',
			'[smarthost]\nhost = "smtp.example.net"\nusername = "u"\npassword = "pw"\ntls = "opportunistic"',
			[
				'smarthost.tls: sends credentials without TLS; set tls = "required" or secure = true',
			],
		],
		[
			'a route for no domain',
			'[routes]\nlocal = "mx"',
			['routes.local: is not a domain name'],
		],
		[
			'a route to no smarthost',
			'[routes]\n"example.org" = "smarthost"',
			['routes."example.org": is "smarthost", but there is no [smarthost]'],
		],
		[
			'a route of another word',
			'[routes]\n"example.org" = "relay"',
			[
				'routes."example.org": must be "mx", "smarthost" or a table with a host',
			],
		],
		[
			'a route with credentials',
			'[routes."example.org"]\nhost = "mx.example.org"\nusername = "u"',
			['routes."example.org".username: unknown key'],
		],
		[
			'relay as a route',
			'[routes]\nrelay = "mx"',
			['routes.relay: not an option: bumail never relays without AUTH'],
		],
	])('%s', async (_, fragment, expected) => {
		const toml = `hostname = "mail.example.com"\n${fragment}\n${ACME}`;
		expect(await problemsOf(toml)).toEqual(expected);
	});

	test('an invalid hostname', async () => {
		expect(await problemsOf(`hostname = "mail"\n${ACME}`)).toEqual([
			'hostname: must be a fully qualified domain name, such as mail.example.com',
		]);
	});

	test('a missing hostname', async () => {
		expect(await problemsOf(ACME)).toEqual([
			'hostname: is required (or set BUMAIL_HOSTNAME)',
		]);
	});

	test('ACME without its answers, or without port 80', async () => {
		expect(
			await problemsOf('hostname = "mail.example.com"\n[ports]\nhttp = 0'),
		).toEqual([
			'ports.http: is 0, but tls.mode "acme" answers its HTTP-01 challenges there',
			"acme.acceptTerms: must be true: the CA's terms of service, read and accepted",
		]);
		expect(
			await problemsOf(
				'hostname = "mail.example.com"\n[acme]\nemail = "postmaster"\nacceptTerms = false\ndirectory = "http://localhost:14000/dir"',
			),
		).toEqual([
			'acme.email: must be an e-mail address',
			"acme.acceptTerms: must be true: the CA's terms of service, read and accepted",
			'acme.directory: the scheme "http:" is not https:',
		]);
	});

	test('files options with ACME, and ACME with files', async () => {
		expect(
			await problemsOf(`${BASE}[tls]\ncert = "cert.pem"\nkey = "key.pem"`),
		).toEqual([
			'tls.cert: is only for tls.mode "files"',
			'tls.key: is only for tls.mode "files"',
		]);
		expect(await problemsOf(`${BASE}[tls]\nmode = "files"`)).toEqual([
			'acme: is only for tls.mode "acme"',
			'tls.cert: is required with tls.mode "files"',
			'tls.key: is required with tls.mode "files"',
		]);
		expect(await problemsOf(`${BASE}[tls]\nmode = "manual"`)).toEqual([
			'tls.mode: must be "acme" or "files"',
		]);
	});

	test('a file that cannot be read, and one that is not TOML', async () => {
		const { readConfig } = await import('./read');
		const missing = '/nonexistent/bumail.toml';
		await expect(readConfig({ path: missing, env: {} })).rejects.toThrow(
			`${missing}:\n  (file): cannot be read (ENOENT)`,
		);
		expect(await problemsOf('hostname = mail.example.com')).toEqual([
			'(file): is not TOML: Strings must be quoted: "…"',
		]);
	});

	test('every problem at once, in one message naming the file', async () => {
		const { errorOf } = await import('./config.fixtures');
		const error = await errorOf('relay = true\n[ports]\nmx = -1\n');
		expect(error.code).toBe('INVALID_CONFIG');
		expect(error.message).toMatch(
			/^\/.*\/bumail\.toml:\n {2}relay: not an option: bumail never relays without AUTH\n {2}hostname: is required \(or set BUMAIL_HOSTNAME\)\n {2}ports\.mx: must be an integer from 0 to 65535\n {2}acme\.acceptTerms: must be true: the CA's terms of service, read and accepted$/,
		);
	});
});

describe('more problems', () => {
	const toml = (fragment: string) =>
		`hostname = "mail.example.com"\n${fragment}\n${ACME}`;

	test.each([
		['RELAY', 'RELAY = true', 'RELAY'],
		[
			'my_networks',
			'[inbound]\nmy_networks = ["10.0.0.0/8"]',
			'inbound.my_networks',
		],
		[
			'trusted-networks',
			'[submission]\ntrusted-networks = []',
			'submission.trusted-networks',
		],
		['Relay as a route', '[routes]\nRelay = "mx"', 'routes.Relay'],
	])('%s is a relay key too', async (_, fragment, path) => {
		expect(await problemsOf(toml(fragment))).toEqual([
			`${path}: not an option: bumail never relays without AUTH`,
		]);
	});

	test('a port that is not a whole number', async () => {
		expect(await problemsOf(toml('[ports]\nmx = 25.5'))).toEqual([
			'ports.mx: must be an integer from 0 to 65535',
		]);
	});

	test('two routes for one domain', async () => {
		expect(
			await problemsOf(
				toml('[routes]\n"example.org" = "mx"\n"Example.ORG." = "mx"'),
			),
		).toEqual([
			'routes."Example.ORG.": is the same domain as routes."example.org"',
		]);
	});

	test('a configuration that is not a regular file, or too large', async () => {
		const { readConfig } = await import('./read');
		const { tempDir, writeConfig } = await import('./config.fixtures');
		const dir = tempDir();
		await expect(readConfig({ path: dir, env: {} })).rejects.toThrow(
			`${dir}:\n  (file): is not a regular file`,
		);
		const large = writeConfig(`# ${'x'.repeat(1024 * 1024)}\n`);
		await expect(readConfig({ path: large, env: {} })).rejects.toThrow(
			`${large}:\n  (file): is larger than 1 MiB`,
		);
	});

	test('a FIFO, read without waiting for a writer', async () => {
		const { readConfig } = await import('./read');
		const { tempDir } = await import('./config.fixtures');
		const fifo = `${tempDir()}/bumail.toml`;
		expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
		await expect(readConfig({ path: fifo, env: {} })).rejects.toThrow(
			`${fifo}:\n  (file): is not a regular file`,
		);
	});

	test('a TOML reason masks what it quotes, double or single', async () => {
		expect(await problemsOf('secret = 1\nsecret = 2\n')).toEqual([
			"(file): is not TOML: Cannot redefine key '…'",
		]);
	});
});
