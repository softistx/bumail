import { afterEach, describe, expect, test } from 'bun:test';
import { basic, PASSWORD, startJmap } from './jmap.fixtures';

let fixture: Awaited<ReturnType<typeof startJmap>> | undefined;

afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
});

interface Session {
	readonly apiUrl: string;
	readonly downloadUrl: string;
	readonly uploadUrl: string;
	readonly username: string;
	readonly primaryAccounts: Record<string, string>;
}

describe('jmap over HTTPS', () => {
	test('serves the session and the API to a user with Basic', async () => {
		fixture = await startJmap();
		const response = await fixture.session({
			authorization: basic(PASSWORD),
		});
		expect(response.status).toBe(200);
		const session = (await response.json()) as Session;
		expect(session.username).toBe('alice@example.com');
		const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
		expect(accountId).toBeString();

		const api = await fetch(
			`https://127.0.0.1:${fixture.port('https')}/jmap/api`,
			{
				method: 'POST',
				headers: {
					authorization: basic(PASSWORD),
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
					methodCalls: [['Mailbox/get', { accountId }, 'm']],
				}),
				tls: { rejectUnauthorized: false },
			},
		);
		const { methodResponses } = (await api.json()) as {
			methodResponses: [string, { list: { role: string | null }[] }, string][];
		};
		expect(methodResponses[0]?.[0]).toBe('Mailbox/get');
		expect(methodResponses[0]?.[1].list.map((m) => m.role)).toContain('inbox');
	});

	test('builds the session URLs from the origin, the default of the hostname', async () => {
		fixture = await startJmap();
		const session = (await (
			await fixture.session({ authorization: basic(PASSWORD) })
		).json()) as Session;
		expect(session.apiUrl).toBe('https://mail.example.com/jmap/api');
		expect(session.downloadUrl).toStartWith(
			'https://mail.example.com/jmap/download/',
		);
		expect(session.uploadUrl).toStartWith(
			'https://mail.example.com/jmap/upload/',
		);
	});

	test('refuses a wrong password and a Bearer token, and logs the first without the password', async () => {
		fixture = await startJmap();
		const wrong = await fixture.session({ authorization: basic('not it') });
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get('www-authenticate')).toContain('Basic');
		const bearer = await fixture.session({ authorization: 'Bearer abc' });
		expect(bearer.status).toBe(401);
		expect((await fixture.session({})).status).toBe(401);
		expect(fixture.lines).toContain(
			'https: login refused from 127.0.0.1: password',
		);
		expect(fixture.lines.join('\n')).not.toContain('not it');
	});

	test('stops counting a client past the limiter: its right password is refused', async () => {
		fixture = await startJmap();
		for (let i = 0; i < 10; i++) {
			await fixture.session({ authorization: basic(`wrong ${i}`) });
		}
		const response = await fixture.session({ authorization: basic(PASSWORD) });
		expect(response.status).toBe(401);
		expect(fixture.lines).toContain(
			'https: login refused from 127.0.0.1: blocked',
		);
	});

	test('logs it at start, one line', async () => {
		fixture = await startJmap();
		const port = fixture.port('https');
		expect(fixture.lines).toContain(
			`bumail: https listening on 0.0.0.0:${port}: JMAP over HTTPS: Basic auth for the users of the directory`,
		);
	});
});
