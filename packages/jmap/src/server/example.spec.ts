import { expect, test } from 'bun:test';
import { app, server } from '../../examples/serve';

test("the README's example serves the session, an email, and its own route", async () => {
	const authorization = 'Bearer alice-secret-token';
	const session = (await (
		await app.request('/.well-known/jmap', { headers: { authorization } })
	).json()) as { primaryAccounts: Record<string, string>; apiUrl: string };
	const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
	expect(session.apiUrl).toBe('http://localhost:8080/jmap/api');
	const response = await app.request('/jmap/api', {
		method: 'POST',
		headers: { authorization, 'content-type': 'application/json' },
		body: JSON.stringify({
			using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
			methodCalls: [
				['Email/query', { accountId }, 'q'],
				[
					'Email/get',
					{
						accountId,
						'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
						properties: ['subject', 'preview'],
					},
					'g',
				],
			],
		}),
	});
	const { methodResponses } = (await response.json()) as {
		methodResponses: [string, { list: unknown[] }, string][];
	};
	expect(methodResponses[1]?.[1].list).toEqual([
		{ id: expect.any(String), subject: 'Hello', preview: 'Hi Alice!' },
	]);
	const basic = `Basic ${btoa('alice:correct horse')}`;
	expect(
		(
			await app.request('/.well-known/jmap', {
				headers: { authorization: basic },
			})
		).status,
	).toBe(403);
	expect(await (await app.request('/health')).text()).toBe('ok');
	expect(() => server.notify(accountId ?? '')).not.toThrow();
});
