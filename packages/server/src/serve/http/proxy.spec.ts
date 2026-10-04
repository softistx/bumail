import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readConfig } from '../../config/read';
import { ServerError } from '../../errors';
import { serve } from '../serve';
import { prepare } from '../serve.fixtures';
import { NO_CLIENT_ADDRESS } from './jmap';
import { basic, PASSWORD, PROXY_CONFIG, startJmap } from './jmap.fixtures';

let fixture: Awaited<ReturnType<typeof startJmap>> | undefined;

afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
});

/** What a proxy sends for a client at `ip`, TLS ended. */
function forwarded(ip: string, extra: Record<string, string> = {}) {
	return {
		'x-forwarded-for': ip,
		'x-forwarded-proto': 'https',
		authorization: basic(PASSWORD),
		...extra,
	};
}

describe('jmap behind a proxy that ends TLS', () => {
	test('serves plain HTTP from a trusted proxy, with the session URLs of the public origin', async () => {
		fixture = await startJmap(PROXY_CONFIG);
		const response = await fixture.session(forwarded('203.0.113.7'));
		expect(response.status).toBe(200);
		const session = (await response.json()) as { apiUrl: string };
		expect(session.apiUrl).toBe('https://jmap.example.org/jmap/api');
		expect(fixture.lines).toContain(
			`bumail: https listening on 0.0.0.0:${fixture.port('https')}: JMAP over plain HTTP for 2 trusted proxies, which end TLS: Basic auth for the users of the directory`,
		);
	});

	test('never takes the session URLs from the Host header', async () => {
		fixture = await startJmap(PROXY_CONFIG);
		const response = await fixture.session(
			forwarded('203.0.113.7', {
				host: 'evil.example',
				'x-forwarded-host': 'evil.example',
			}),
		);
		const session = (await response.json()) as {
			apiUrl: string;
			downloadUrl: string;
			uploadUrl: string;
		};
		expect(JSON.stringify(session)).not.toContain('evil.example');
		expect(session.apiUrl).toStartWith('https://jmap.example.org/');
	});

	test('counts failed logins per forwarded client, not in the proxy bucket', async () => {
		fixture = await startJmap(PROXY_CONFIG);
		for (let i = 0; i < 10; i++) {
			await fixture.session(
				forwarded('203.0.113.7', { authorization: basic(`wrong ${i}`) }),
			);
		}
		expect(fixture.lines).toContain(
			'https: login refused from 203.0.113.7: password',
		);
		// The client that failed is blocked, its right password included…
		const blocked = await fixture.session(forwarded('203.0.113.7'));
		expect(blocked.status).toBe(401);
		expect(fixture.lines).toContain(
			'https: login refused from 203.0.113.7: blocked',
		);
		// …another behind the same proxy, and the proxy itself, are not.
		expect((await fixture.session(forwarded('203.0.113.8'))).status).toBe(200);
		expect(
			(
				await fixture.session({
					authorization: basic(PASSWORD),
					'x-forwarded-proto': 'https',
				})
			).status,
		).toBe(200);
	});

	test('takes the right-most entry that is not a trusted proxy: a spoofed chain does not pick the bucket', async () => {
		fixture = await startJmap(PROXY_CONFIG);
		// The client claims 192.0.2.1 on the left; the proxy appended the real one.
		await fixture.session(
			forwarded('192.0.2.1, 198.51.100.9', { authorization: basic('wrong') }),
		);
		// A trusted proxy behind that one is skipped.
		await fixture.session(
			forwarded('192.0.2.1, 198.51.100.10, 127.0.0.1', {
				authorization: basic('wrong'),
			}),
		);
		expect(fixture.lines).toContain(
			'https: login refused from 198.51.100.9: password',
		);
		expect(fixture.lines).toContain(
			'https: login refused from 198.51.100.10: password',
		);
		expect(fixture.lines.join('\n')).not.toContain('from 192.0.2.1');
	});

	test('falls back to the proxy for a chain with no usable client', async () => {
		fixture = await startJmap(PROXY_CONFIG);
		await fixture.session(
			forwarded('not-an-ip', { authorization: basic('wrong') }),
		);
		expect(fixture.lines).toContain(
			'https: login refused from 127.0.0.1: password',
		);
	});

	test('refuses Basic when the proxy does not say TLS ended', async () => {
		fixture = await startJmap(PROXY_CONFIG);
		const response = await fixture.session({
			authorization: basic(PASSWORD),
			'x-forwarded-for': '203.0.113.7',
		});
		expect(response.status).toBe(403);
	});

	test('ignores X-Forwarded-For and X-Forwarded-Proto from a peer that is not trusted', async () => {
		fixture = await startJmap(
			PROXY_CONFIG.replace('["127.0.0.1", "::1"]', '["10.9.9.9"]'),
		);
		const response = await fixture.session(
			forwarded('203.0.113.7', { authorization: basic('wrong') }),
		);
		// Not secure by the peer's say-so: Basic is refused before it is checked.
		expect(response.status).toBe(403);
		expect(fixture.lines.join('\n')).not.toContain('203.0.113.7');
		expect((await fixture.session(forwarded('203.0.113.7'))).status).toBe(403);
	});

	test('answers 403 to every request of a peer it does not trust, before it reads a header', async () => {
		fixture = await startJmap(
			PROXY_CONFIG.replace('["127.0.0.1", "::1"]', '["10.9.9.9"]'),
		);
		for (const headers of [
			{},
			forwarded('203.0.113.7'),
			{ 'x-forwarded-proto': 'https' },
		]) {
			expect((await fixture.session(headers)).status).toBe(403);
		}
		expect(fixture.lines.join('\n')).not.toContain('login refused');
	});

	test('a network of the other family trusts nobody: ::/8 does not trust 127.0.0.1', async () => {
		fixture = await startJmap(
			PROXY_CONFIG.replace('["127.0.0.1", "::1"]', '["::/8"]'),
		);
		expect((await fixture.session(forwarded('203.0.113.7'))).status).toBe(403);
	});

	test('refuses to start without a client address to count: a unix socket', async () => {
		const { file } = await prepare(PROXY_CONFIG);
		const config = await readConfig({ path: file, env: {} });
		const lines: string[] = [];
		const error = await serve(
			{
				...config,
				jmap: { ...config.jmap, bind: join(config.data, 'jmap.sock') },
			},
			{ log: (line) => lines.push(line), port: () => 0 },
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ServerError);
		expect((error as ServerError).code).toBe('UNAVAILABLE');
		expect((error as ServerError).message).toContain(NO_CLIENT_ADDRESS);
		expect(lines.join('\n')).not.toContain('serving');
	});
});
