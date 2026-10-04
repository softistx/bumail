import { describe, expect, test } from 'bun:test';
import { http01Responder } from '../challenge/responder';
import { AcmeError } from '../errors';
import { generateKeyPair } from '../keys/keys';
import { AcmeClient } from './client';
import { BASE, FAKE_CHAIN, FakeCa, PROBLEM } from './fake-ca.fixtures';
import { type Http01Hooks, obtainCertificate } from './obtain';

const accountKey = await generateKeyPair();
const certificateKey = await generateKeyPair();

async function setUp(ca = new FakeCa()) {
	const client = new AcmeClient({
		directoryUrl: `${BASE}/dir`,
		accountKey,
		fetch: ca.fetch,
		pollIntervalMs: 10,
	});
	await client.newAccount({ termsOfServiceAgreed: true });
	return { ca, client };
}

/** Hooks that log every call, and keep what is served in a map. */
function loggingHooks(fail: { set?: number; remove?: boolean } = {}) {
	const served = new Map<string, string>();
	const calls: string[] = [];
	const hooks: Http01Hooks = {
		async set(token, keyAuthorization) {
			calls.push(`set ${token}`);
			if (fail.set !== undefined && calls.length === fail.set) {
				throw new Error('the responder is down');
			}
			served.set(token, keyAuthorization);
		},
		async remove(token) {
			calls.push(`remove ${token}`);
			served.delete(token);
			if (fail.remove) throw new Error('could not remove');
		},
	};
	return { hooks, served, calls };
}

async function rejection(promise: Promise<unknown>): Promise<AcmeError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AcmeError) return error;
		throw error;
	}
	throw new Error('expected a rejection');
}

describe('obtainCertificate', () => {
	test('runs the whole HTTP-01 flow and returns the chain', async () => {
		const { ca, client } = await setUp();
		const responder = http01Responder();
		const served: string[] = [];
		const result = await obtainCertificate({
			client,
			names: ['a.example', 'b.example'],
			certificateKey,
			http01: {
				set(token, keyAuthorization) {
					responder.set(token, keyAuthorization);
					served.push(token);
				},
				remove: (token) => responder.remove(token),
			},
		});
		expect(result.certificate).toBe(FAKE_CHAIN);
		expect(result.order.status).toBe('valid');
		expect(result.csr.names).toEqual(['a.example', 'b.example']);
		expect(served).toEqual(['token0http01', 'token1http01']);
		expect(responder.size).toBe(0);
		expect(ca.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			'GET /dir',
			'POST /account',
			'POST /order',
			'POST /authz/0',
			'POST /chall/0/http-01',
			'POST /authz/1',
			'POST /chall/1/http-01',
			'POST /authz/0',
			'POST /authz/1',
			'POST /order/1',
			'POST /finalize/1',
			'POST /cert/1',
		]);
	});

	test('serves the key authorization of the account key', async () => {
		const { client } = await setUp();
		const { hooks, calls } = loggingHooks();
		const answers: string[] = [];
		await obtainCertificate({
			client,
			names: ['a.example'],
			certificateKey,
			http01: {
				set: (token, keyAuthorization) => {
					answers.push(keyAuthorization);
					return hooks.set(token, keyAuthorization);
				},
				remove: hooks.remove,
			},
		});
		expect(answers).toEqual([
			`token0http01.${await client.accountThumbprint()}`,
		]);
		expect(calls).toEqual(['set token0http01', 'remove token0http01']);
	});

	test('removes every token when an authorization fails', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /chall/1/http-01', (_, fake) => {
			fake.authorizations[1] = 'invalid';
			return fake.json({
				type: 'http-01',
				url: `${BASE}/chall/1/http-01`,
				status: 'invalid',
				error: { type: `${PROBLEM}connection`, detail: 'Connection refused' },
			});
		});
		ca.routes.set('POST /authz/1', (_, fake) => {
			const authorization = fake.authorization(1);
			if (fake.authorizations[1] === 'invalid') {
				authorization['status'] = 'invalid';
				(authorization['challenges'] as Record<string, unknown>[])[0] = {
					type: 'http-01',
					url: `${BASE}/chall/1/http-01`,
					status: 'invalid',
					error: { type: `${PROBLEM}connection`, detail: 'Connection refused' },
				};
			}
			return fake.json(authorization);
		});
		const { hooks, served, calls } = loggingHooks();
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example', 'b.example'],
				certificateKey,
				http01: hooks,
			}),
		);
		expect(error.code).toBe('AUTHORIZATION_FAILED');
		expect(error.problem?.type).toBe(`${PROBLEM}connection`);
		expect(served.size).toBe(0);
		expect(calls).toEqual([
			'set token0http01',
			'set token1http01',
			'remove token0http01',
			'remove token1http01',
		]);
	});

	test('removes the tokens set so far, and the one being set, when set throws', async () => {
		const { client } = await setUp();
		const { hooks, served, calls } = loggingHooks({ set: 2 });
		await expect(
			obtainCertificate({
				client,
				names: ['a.example', 'b.example'],
				certificateKey,
				http01: hooks,
			}),
		).rejects.toThrow('the responder is down');
		expect(served.size).toBe(0);
		expect(calls).toEqual([
			'set token0http01',
			'set token1http01',
			'remove token0http01',
			'remove token1http01',
		]);
	});

	test('removes the tokens when aborted while waiting', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /chall/0/http-01', (request, fake) =>
			fake.json({ type: 'http-01', url: request.url, status: 'processing' }),
		);
		const { hooks, served, calls } = loggingHooks();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: hooks,
				signal: controller.signal,
			}),
		);
		expect(error.code).toBe('ABORTED');
		expect(error.message).toBe('obtainCertificate(): aborted');
		expect(served.size).toBe(0);
		expect(calls).toEqual(['set token0http01', 'remove token0http01']);
	});

	test('is TIMEOUT after timeoutMs, the tokens removed', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /chall/0/http-01', (request, fake) =>
			fake.json({ type: 'http-01', url: request.url, status: 'processing' }),
		);
		const { hooks, served } = loggingHooks();
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: hooks,
				timeoutMs: 100,
			}),
		);
		expect(error.code).toBe('TIMEOUT');
		expect(error.message).toBe(
			'obtainCertificate(): no certificate within 100 ms',
		);
		expect(served.size).toBe(0);
	});

	test('a remove that fails after the authorizations succeeded is thrown, every token tried', async () => {
		const { ca, client } = await setUp();
		const { hooks, calls } = loggingHooks({ remove: true });
		await expect(
			obtainCertificate({
				client,
				names: ['a.example', 'b.example'],
				certificateKey,
				http01: hooks,
			}),
		).rejects.toThrow('could not remove');
		expect(calls.filter((call) => call.startsWith('remove'))).toHaveLength(2);
		expect(ca.to('/finalize/1')).toHaveLength(0);
	});

	test('an authorization already valid is not challenged again', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /order', (_, fake) => {
			fake.names = ['a.example', 'b.example'];
			fake.authorizations = ['valid', 'pending'];
			return fake.json(fake.order(), 201, { location: `${BASE}/order/1` });
		});
		const { hooks, calls } = loggingHooks();
		await obtainCertificate({
			client,
			names: ['a.example', 'b.example'],
			certificateKey,
			http01: hooks,
		});
		expect(calls).toEqual(['set token1http01', 'remove token1http01']);
		expect(ca.to('/chall/0/http-01')).toHaveLength(0);
	});

	test('an authorization without http-01 is AUTHORIZATION_FAILED', async () => {
		const ca = new FakeCa();
		ca.challengeTypes = ['dns-01'];
		const { client } = await setUp(ca);
		const { hooks, calls } = loggingHooks();
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: hooks,
			}),
		);
		expect(error.code).toBe('AUTHORIZATION_FAILED');
		expect(error.message).toBe(
			'obtainCertificate(): the authorization for "a.example" offers no http-01 challenge',
		);
		expect(calls).toEqual([]);
	});

	test('the account key as the certificate key is INVALID_KEY', async () => {
		const { client } = await setUp();
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey: accountKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('INVALID_KEY');
		expect(error.message).toBe(
			'obtainCertificate(): certificateKey is the account key; a certificate needs a key of its own',
		);
	});

	test('a client without an account is NO_ACCOUNT', async () => {
		const client = new AcmeClient({
			directoryUrl: `${BASE}/dir`,
			accountKey,
			fetch: new FakeCa().fetch,
		});
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('NO_ACCOUNT');
	});

	test.each([
		[
			{ http01: {} },
			'obtainCertificate(): http01 must be { set(token, keyAuthorization), remove(token) }',
		],
		[{ client: {} }, 'obtainCertificate(): client must be an AcmeClient'],
		[
			{ timeoutMs: 0 },
			'obtainCertificate(): timeoutMs must be an integer from 1 to 3600000, not number',
		],
	])('%p is INVALID_OPTION', async (override, message) => {
		const { client } = await setUp();
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
				...(override as object),
			}),
		);
		expect(error.code).toBe('INVALID_OPTION');
		expect(error.message).toBe(message);
	});

	test('a wildcard name is refused before any request', async () => {
		const { ca, client } = await setUp();
		const before = ca.requests.length;
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['*.example.com'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('INVALID_NAME');
		expect(ca.requests).toHaveLength(before);
	});
});
