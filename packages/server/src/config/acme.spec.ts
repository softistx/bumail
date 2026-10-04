import { describe, expect, test } from 'bun:test';
import { problemsOf, writeConfig } from './config.fixtures';
import { readConfig } from './read';

const HEAD = 'hostname = "Mail.Example.com"\ndata = "/srv/bumail"\n';
const TERMS = 'acceptTerms = true\n';

async function acmeOf(toml: string) {
	const config = await readConfig({ path: writeConfig(toml), env: {} });
	if (config.acme === undefined) throw new Error('no [acme]');
	return config.acme;
}

describe('[acme]', () => {
	test('the defaults: no contact, production, the hostname, <data>/acme, 30 days, bind', async () => {
		expect(await acmeOf(`${HEAD}[acme]\n${TERMS}`)).toEqual({
			email: undefined,
			acceptTerms: true,
			directory: 'https://acme-v02.api.letsencrypt.org/directory',
			names: ['mail.example.com'],
			dir: '/srv/bumail/acme',
			renewBeforeDays: 30,
			bind: '0.0.0.0',
		});
	});

	test('every key, "staging" for the staging directory, the hostname once', async () => {
		const acme = await acmeOf(
			`${HEAD}bind = "10.0.0.5"\n[acme]\n${TERMS}email = "ops@example.com"\ndirectory = "staging"\nnames = ["imap.example.com", "MAIL.example.com.", "imap.example.com"]\ndir = "/srv/state/acme/"\nrenewBeforeDays = 20\nbind = "::"\n`,
		);
		expect(acme).toEqual({
			email: 'ops@example.com',
			acceptTerms: true,
			directory: 'https://acme-staging-v02.api.letsencrypt.org/directory',
			names: ['mail.example.com', 'imap.example.com'],
			dir: '/srv/state/acme',
			renewBeforeDays: 20,
			bind: '::',
		});
	});

	test('the challenge listener binds to the top-level bind by default; any https URL is a directory', async () => {
		const acme = await acmeOf(
			`${HEAD}bind = "10.0.0.5"\n[acme]\n${TERMS}directory = "https://localhost:14000/dir"\n`,
		);
		expect(acme.bind).toBe('10.0.0.5');
		expect(acme.directory).toBe('https://localhost:14000/dir');
	});

	test('what check-config refuses, each with its path', async () => {
		expect(
			await problemsOf(
				`${HEAD}[acme]\n${TERMS}names = ["*.example.com", "mail", "1.2.3.4", 7]\ndir = "acme"\nrenewBeforeDays = 0\nbind = "everywhere"\nemail = "x"\n`,
			),
		).toEqual([
			'acme.email: must be an e-mail address',
			'acme.names[0]: is a wildcard, which HTTP-01 cannot prove',
			'acme.names[1]: must be a fully qualified domain name, such as imap.example.com',
			'acme.names[2]: must be a fully qualified domain name, such as imap.example.com',
			'acme.names[3]: must be a string',
			'acme.dir: must be an absolute path',
			'acme.renewBeforeDays: must be an integer from 1 to 365',
			'acme.bind: must be an IPv4 or IPv6 address',
		]);
		expect(
			await problemsOf(
				`${HEAD}[acme]\n${TERMS}names = "a.example.com"\ndirectory = 4\n`,
			),
		).toEqual([
			'acme.directory: must be a string',
			'acme.names: must be an array of DNS names',
		]);
		expect(
			await problemsOf(
				`${HEAD}[acme]\n${TERMS}directory = "http://x.example/dir"`,
			),
		).toEqual(['acme.directory: the scheme "http:" is not https:']);
		expect(
			await problemsOf(`${HEAD}[acme]\nacceptTerms = true\nstate = "x"`),
		).toEqual(['acme.state: unknown key']);
	});

	test('more than a certificate holds', async () => {
		const names = Array.from({ length: 100 }, (_, i) => `"n${i}.example.com"`);
		expect(
			await problemsOf(
				`${HEAD}[acme]\n${TERMS}names = [${names.join(', ')}]\n`,
			),
		).toEqual(['acme.names: are more than the 100 a certificate holds']);
	});

	test('pollSeconds is still refused with ACME', async () => {
		expect(
			await problemsOf(`${HEAD}[tls]\npollSeconds = 30\n[acme]\n${TERMS}`),
		).toEqual(['tls.pollSeconds: is only for tls.mode "files"']);
	});

	test('a file with no [acme] is refused for its terms', async () => {
		expect(await problemsOf(HEAD)).toEqual([
			"acme.acceptTerms: must be true: the CA's terms of service, read and accepted",
		]);
	});
});
