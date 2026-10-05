import { afterEach, describe, expect, test } from 'bun:test';
import { JmapError } from '../errors';
import { CORE, type Harness, harness, MAIL, ORIGIN } from './app.fixtures';

const basic = (user: string, password: string) =>
	`Basic ${btoa(`${user}:${password}`)}`;

describe('the session', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8620 §2: capabilities with every limit, the account, primaryAccounts, the URLs and a state', async () => {
		h = await harness();
		const response = await h.fetch('/.well-known/jmap');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const session = (await response.json()) as any;
		expect(session.capabilities[CORE]).toEqual({
			maxSizeUpload: 25 * 1024 * 1024,
			maxConcurrentUpload: 4,
			maxSizeRequest: 10_000_000,
			maxConcurrentRequests: 4,
			maxCallsInRequest: 16,
			maxObjectsInGet: 500,
			maxObjectsInSet: 500,
			collationAlgorithms: ['i;unicode-casemap'],
		});
		expect(session.capabilities[MAIL]).toEqual({});
		expect(Object.keys(session.accounts)).toEqual([h.alice.id]);
		expect(session.accounts[h.alice.id]).toMatchObject({
			name: 'alice@example.com',
			isPersonal: true,
			isReadOnly: false,
		});
		expect(
			session.accounts[h.alice.id].accountCapabilities[MAIL]
				.emailQuerySortOptions,
		).toContain('receivedAt');
		expect(session.primaryAccounts).toEqual({ [MAIL]: h.alice.id });
		expect(session).toMatchObject({
			username: 'alice@example.com',
			apiUrl: `${ORIGIN}/jmap/api`,
			downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
			uploadUrl: `${ORIGIN}/jmap/upload/{accountId}`,
		});
		const { sessionState } = await h.api([]);
		expect(sessionState).toBe(session.state);
	});

	test('basePath moves the API, download and upload; the host keeps its own routes unauthenticated', async () => {
		h = await harness('memory', { basePath: '/mail/jmap' });
		const session = (await (
			await h.fetch('/.well-known/jmap')
		).json()) as Record<string, string>;
		expect(session['apiUrl']).toBe(`${ORIGIN}/mail/jmap/api`);
		const api = await h.fetch('/mail/jmap/api', {
			method: 'POST',
			body: '{"using":[],"methodCalls":[]}',
		});
		expect(api.status).toBe(200);
		const health = await h.host.fetch(new Request(`${ORIGIN}/health`));
		expect(await health.text()).toBe('ok');
	});
});

describe('authentication', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('no credentials, or wrong ones, are a 401 with both challenges', async () => {
		h = await harness();
		for (const authorization of ['', 'Bearer wrong', 'Digest x', 'Basic !!!']) {
			const response = await h.fetch('/.well-known/jmap', {
				headers: { authorization },
			});
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toContain(
				'Basic realm="JMAP"',
			);
			expect(response.headers.get('www-authenticate')).toContain(
				'Bearer realm="JMAP"',
			);
			expect(response.headers.get('content-type')).toBe(
				'application/problem+json',
			);
		}
	});

	test('a wrong method is a 401 before it is a 405: Allow is said to an authenticated client alone', async () => {
		h = await harness();
		const routes: [string, string, string][] = [
			['/.well-known/jmap', 'DELETE', 'GET'],
			['/jmap/api', 'GET', 'POST'],
			[`/jmap/download/${h.alice.id}/b1/x.eml`, 'PUT', 'GET'],
			[`/jmap/upload/${h.alice.id}`, 'GET', 'POST'],
		];
		for (const [path, method, allow] of routes) {
			for (const authorization of ['', 'Bearer wrong']) {
				const refused = await h.fetch(path, {
					method,
					headers: { authorization },
				});
				expect(refused.status).toBe(401);
				expect(refused.headers.get('allow')).toBeNull();
				expect(refused.headers.get('www-authenticate')).toContain(
					'Bearer realm="JMAP"',
				);
			}
			const wrong = await h.fetch(path, {
				method,
				headers: { authorization: 'Bearer alice-token' },
			});
			expect(wrong.status).toBe(405);
			expect(wrong.headers.get('allow')).toBe(allow);
		}
		const nowhere = await h.fetch('/nowhere', {
			headers: { authorization: '' },
		});
		expect(nowhere.status).toBe(404);
	});

	test('Basic is refused unread on a clear request, as imap and smtp refuse AUTH before TLS', async () => {
		const seen: unknown[] = [];
		h = await harness('memory', {
			authenticate: (credentials) => {
				seen.push(credentials);
				return null;
			},
		});
		const clear = await h.host.fetch(
			new Request('http://mail.example.com/.well-known/jmap', {
				headers: { authorization: basic('alice', 'pw') },
			}),
		);
		expect(clear.status).toBe(403);
		expect(((await clear.json()) as { detail: string }).detail).toBe(
			'Basic authentication is refused on a clear connection: use HTTPS',
		);
		expect(seen).toEqual([]);
		await h.fetch('/.well-known/jmap', {
			headers: { authorization: basic('alice', 'pw:with:colons') },
		});
		expect(seen).toEqual([
			{ scheme: 'basic', username: 'alice', password: 'pw:with:colons' },
		]);
	});

	test('allowInsecureBasic takes Basic on a clear request, for local tests', async () => {
		h = await harness('memory', {
			allowInsecureBasic: true,
			authenticate: (c) =>
				c.scheme === 'basic' && c.password === 'pw' ? h.alice.id : null,
		});
		const clear = await h.host.fetch(
			new Request('http://localhost/.well-known/jmap', {
				headers: { authorization: basic('alice', 'pw') },
			}),
		);
		expect(clear.status).toBe(200);
	});

	test('an authenticate that throws, hangs or names no account is a 503, told to onError', async () => {
		const errors: unknown[] = [];
		const onError = (error: unknown) => errors.push(error);
		h = await harness('memory', {
			onError,
			hookTimeout: 1,
			authenticate: () => new Promise(() => {}),
		});
		const hung = await h.fetch('/.well-known/jmap');
		expect(hung.status).toBe(503);
		expect(errors[0]).toBeInstanceOf(JmapError);
		expect((errors[0] as JmapError).message).toBe(
			'authenticate did not settle within hookTimeout (1 s)',
		);
		await h.close();
		h = await harness('memory', {
			onError,
			authenticate: () => 'no-such-account',
		});
		expect((await h.fetch('/.well-known/jmap')).status).toBe(503);
		expect((errors[1] as Error).message).toBe(
			'authenticate answered the account "no-such-account", which the store does not have',
		);
		await h.close();
		h = await harness('memory', {
			onError,
			authenticate: () => {
				throw new Error('down');
			},
		});
		expect((await h.fetch('/.well-known/jmap')).status).toBe(503);
		expect((errors[2] as Error).message).toBe('down');
	});
});
