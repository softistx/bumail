import { describe, expect, test } from 'bun:test';
import { BASE, problemsOf, writeConfig } from './config.fixtures';
import { readConfig } from './read';

const PROXY = `[ports]
https = 8081
[jmap]
mode = "proxy"
origin = "https://jmap.example.org"
trusted = ["10.0.0.0/8", "fd00::/8"]
`;

async function read(toml: string) {
	return readConfig({ env: {}, path: writeConfig(toml) });
}

describe('[jmap]', () => {
	test('is direct HTTPS by default, its origin from the hostname', async () => {
		const { jmap } = await read(BASE);
		expect(jmap).toEqual({
			origin: 'https://mail.example.com',
			mode: 'https',
			bind: '0.0.0.0',
			trusted: [],
		});
	});

	test('takes a proxy: its mode, origin, address and proxies', async () => {
		const { jmap, ports } = await read(
			`bind = "::"\n${BASE}\n${PROXY}bind = "10.1.2.3"\n`,
		);
		expect(jmap).toEqual({
			origin: 'https://jmap.example.org',
			mode: 'proxy',
			bind: '10.1.2.3',
			trusted: ['10.0.0.0/8', 'fd00::/8'],
		});
		expect(ports.https).toBe(8081);
	});

	test('behind a proxy, requires origin, trusted and ports.https', async () => {
		expect(await problemsOf(`${BASE}\n[jmap]\nmode = "proxy"`)).toEqual([
			'jmap.origin: is required with jmap.mode "proxy": the public URL clients reach, such as https://mail.example.com',
			'ports.https: is required with jmap.mode "proxy": the plain HTTP port the proxy reaches',
			'jmap.trusted: is required with jmap.mode "proxy": the addresses or CIDRs of the proxies',
		]);
	});

	test('with no ports.https needed when JMAP is off', async () => {
		const toml = `${BASE}\n[ports]\nhttps = 0\n[jmap]\nmode = "proxy"\norigin = "https://j.example.org"\ntrusted = ["10.0.0.1"]`;
		expect((await read(toml)).ports.https).toBe(0);
	});

	test('refuses trusted with direct HTTPS, a mode it does not know, and a bind that is no address', async () => {
		expect(await problemsOf(`${BASE}\n[jmap]\ntrusted = ["10.0.0.1"]`)).toEqual(
			['jmap.trusted: is only for jmap.mode "proxy"'],
		);
		expect(await problemsOf(`${BASE}\n[jmap]\nmode = "tls"`)).toEqual([
			'jmap.mode: must be "https" or "proxy"',
		]);
		expect(
			await problemsOf(`${BASE}\n[jmap]\nbind = "/run/jmap.sock"`),
		).toEqual(['jmap.bind: must be an IPv4 or IPv6 address']);
	});

	test('refuses an origin that is not https:, without repeating it', async () => {
		const problems = await problemsOf(
			`${BASE}\n[jmap]\norigin = "http://secret.example.org/x"`,
		);
		expect(problems).toEqual(['jmap.origin: the scheme "http:" is not https:']);
	});

	test('refuses a key it does not know', async () => {
		expect(await problemsOf(`${BASE}\n[jmap]\nproxies = ["10.0.0.1"]`)).toEqual(
			['jmap.proxies: unknown key'],
		);
	});
});

describe('trusted lists', () => {
	const jmap = (list: string) =>
		`${PROXY.replace(/trusted = .*/, `trusted = ${list}`)}`;

	test('name the entry by its place, never repeat it', async () => {
		const problems = await problemsOf(
			`${BASE}\n${jmap('["10.0.0.1", "proxy.example.org", "10.0.0.0/33", "10.0.0.0/0", "::/0", "fe80::1%eth0", "10.0.0.0/8/8", "::ffff:10.0.0.0/64", 5, "10.0.0.1/x"]')}`,
		);
		expect(problems).toEqual([
			'jmap.trusted[1]: is neither an IP address nor a CIDR',
			'jmap.trusted[2]: has a prefix length out of range',
			'jmap.trusted[3]: has a prefix length of 0, which trusts every peer',
			'jmap.trusted[4]: has a prefix length of 0, which trusts every peer',
			'jmap.trusted[5]: is neither an IP address nor a CIDR',
			'jmap.trusted[6]: is neither an IP address nor a CIDR',
			'jmap.trusted[7]: has a prefix length out of range',
			'jmap.trusted[8]: is not a string',
			'jmap.trusted[9]: has a prefix length out of range',
		]);
	});

	test('must be a non-empty array', async () => {
		for (const list of ['[]', '"10.0.0.1"']) {
			expect(await problemsOf(`${BASE}\n${jmap(list)}`)).toEqual([
				'jmap.trusted: must list the addresses or CIDRs of the proxies, at least one',
			]);
		}
	});
});

describe('[proxyProtocol]', () => {
	test('is off by default, and on with its proxies', async () => {
		expect((await read(BASE)).proxyProtocol).toBeUndefined();
		const config = await read(
			`${BASE}\n[proxyProtocol]\ntrusted = ["172.18.0.0/16", "::1"]`,
		);
		expect(config.proxyProtocol).toEqual({ trusted: ['172.18.0.0/16', '::1'] });
	});

	test('is refused without trusted, with an empty or bad one, and with a key it does not know', async () => {
		expect(await problemsOf(`${BASE}\n[proxyProtocol]`)).toEqual([
			'proxyProtocol.trusted: is required: the addresses or CIDRs of the proxies, or remove [proxyProtocol] to turn it off',
		]);
		expect(await problemsOf(`${BASE}\n[proxyProtocol]\ntrusted = []`)).toEqual([
			'proxyProtocol.trusted: must list the addresses or CIDRs of the proxies, at least one',
		]);
		expect(
			await problemsOf(
				`${BASE}\n[proxyProtocol]\ntrusted = ["mail.example.org", "0.0.0.0/0"]`,
			),
		).toEqual([
			'proxyProtocol.trusted[0]: is neither an IP address nor a CIDR',
			'proxyProtocol.trusted[1]: has a prefix length of 0, which trusts every peer',
		]);
		expect(
			await problemsOf(
				`${BASE}\n[proxyProtocol]\ntrusted = ["10.0.0.1"]\nlisteners = ["mx"]`,
			),
		).toEqual(['proxyProtocol.listeners: unknown key']);
	});
});

describe('[health]', () => {
	test('binds loopback by default, or the address it names', async () => {
		expect((await read(BASE)).health).toEqual({ bind: '127.0.0.1' });
		expect(
			(await read(`${BASE}\n[health]\nbind = "0.0.0.0"`)).health.bind,
		).toBe('0.0.0.0');
	});

	test('refuses a bind that is no address', async () => {
		expect(await problemsOf(`${BASE}\n[health]\nbind = "localhost"`)).toEqual([
			'health.bind: must be an IPv4 or IPv6 address',
		]);
	});
});
