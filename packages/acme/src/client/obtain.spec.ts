import { describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { http01Responder } from '../challenge/responder';
import { AcmeError } from '../errors';
import { generateKeyPair } from '../keys/keys';
import { AcmeClient } from './client';
import { BASE, FakeCa, PROBLEM } from './fake-ca.fixtures';
import { obtainCertificate } from './obtain';
import type { Http01Hooks } from './tokens';

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
		expect(result.certificate).toBe(ca.chain ?? '');
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

describe('obtainCertificate: hooks that hang, and answers that do not match', () => {
	test('a set that lands after timeoutMs is still removed, once it settled', async () => {
		const { client } = await setUp();
		const responder = http01Responder();
		const calls: string[] = [];
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: {
					async set(token, keyAuthorization) {
						await Bun.sleep(200);
						calls.push(`set ${token}`);
						responder.set(token, keyAuthorization);
					},
					remove(token) {
						calls.push(`remove ${token}`);
						responder.remove(token);
					},
				},
				timeoutMs: 50,
			}),
		);
		expect(error.code).toBe('TIMEOUT');
		expect(error.message).toBe(
			'obtainCertificate(): no certificate within 50 ms',
		);
		expect(calls).toEqual(['set token0http01', 'remove token0http01']);
		expect(responder.size).toBe(0);
	});

	test('a set that lands after the signal aborted is still removed', async () => {
		const { client } = await setUp();
		const responder = http01Responder();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: {
					async set(token, keyAuthorization) {
						await Bun.sleep(150);
						responder.set(token, keyAuthorization);
					},
					remove: (token) => responder.remove(token),
				},
				signal: controller.signal,
			}),
		);
		expect(error.code).toBe('ABORTED');
		expect(responder.size).toBe(0);
	});

	test('when the flow failed and remove throws too, the flow’s error wins', async () => {
		const ca = new FakeCa();
		ca.challengeTypes = ['http-01'];
		ca.routes.set('POST /authz/0', (_, fake) => {
			const authorization = fake.authorization(0);
			if (fake.requests.some((r) => r.path === '/chall/0/http-01')) {
				authorization['status'] = 'invalid';
			}
			return fake.json(authorization);
		});
		const { client } = await setUp(ca);
		const { hooks, calls } = loggingHooks({ remove: true });
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: hooks,
			}),
		);
		expect(error.code).toBe('AUTHORIZATION_FAILED');
		expect(calls).toEqual(['set token0http01', 'remove token0http01']);
	});

	test('a valid order without a certificate URL is BAD_RESPONSE', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /finalize/1', (_, fake) => {
			fake.orderStatus = 'valid';
			const { certificate: _certificate, ...order } = fake.order();
			return fake.json(order);
		});
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`obtainCertificate(): the CA's order is "valid" but has no "certificate"`,
		);
	});

	test('an order for other names than requested is BAD_RESPONSE, nothing set', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /order', (_, fake) => {
			fake.names = ['a.example', 'evil.example'];
			return fake.json(fake.order(), 201, { location: `${BASE}/order/1` });
		});
		const { hooks, calls } = loggingHooks();
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: hooks,
			}),
		);
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`obtainCertificate(): the CA's order is for "a.example, evil.example", not the names requested`,
		);
		expect(calls).toEqual([]);
	});

	test('the same names in another order and case are accepted', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /order', (request, fake) => {
			const { identifiers } = request.payload as {
				identifiers: { value: string }[];
			};
			fake.names = identifiers.map((i) => i.value);
			fake.authorizations = fake.names.map(() => 'pending');
			const order = fake.order();
			order['identifiers'] = [...fake.names]
				.reverse()
				.map((value) => ({ type: 'dns', value: value.toUpperCase() }));
			return fake.json(order, 201, { location: `${BASE}/order/1` });
		});
		const result = await obtainCertificate({
			client,
			names: ['a.example', 'b.example'],
			certificateKey,
			http01: loggingHooks().hooks,
		});
		expect(result.order.status).toBe('valid');
	});

	test('an order with more authorizations than names is BAD_RESPONSE', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /order', (_, fake) => {
			fake.names = ['a.example'];
			const order = fake.order();
			order['authorizations'] = [`${BASE}/authz/0`, `${BASE}/authz/1`];
			return fake.json(order, 201, { location: `${BASE}/order/1` });
		});
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			"obtainCertificate(): the CA's order lists 2 authorizations for 1 names",
		);
	});

	test('an order already valid before finalize is BAD_RESPONSE', async () => {
		const { ca, client } = await setUp();
		ca.routes.set('POST /order/1', (_, fake) => {
			fake.orderStatus = 'valid';
			return fake.json(fake.order());
		});
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`obtainCertificate(): the CA's order is "valid" before it was finalized`,
		);
		expect(ca.to('/finalize/1')).toEqual([]);
	});

	test('a certificate for another key is BAD_RESPONSE', async () => {
		const { ca, client } = await setUp();
		ca.issueSpki = new Uint8Array(
			await crypto.subtle.exportKey(
				'spki',
				(await generateKeyPair()).publicKey,
			),
		);
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			"obtainCertificate(): the CA's certificate is not for certificateKey",
		);
	});

	test('a certificate for other names is BAD_RESPONSE', async () => {
		const { ca, client } = await setUp();
		ca.issueNames = ['a.example', 'evil.example'];
		const error = await rejection(
			obtainCertificate({
				client,
				names: ['a.example'],
				certificateKey,
				http01: loggingHooks().hooks,
			}),
		);
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`obtainCertificate(): the CA's certificate names "DNS:a.example, DNS:evil.example", not the names requested`,
		);
	});

	test('the leaf is checked against the CSR: its key and its names', async () => {
		const { client } = await setUp();
		const result = await obtainCertificate({
			client,
			names: ['b.example', 'a.example'],
			certificateKey,
			http01: loggingHooks().hooks,
		});
		const [block] = result.certificate.split(
			/(?<=-----END CERTIFICATE-----)\n/,
		);
		const leaf = new X509Certificate(block ?? '');
		expect(leaf.subjectAltName).toBe('DNS:b.example, DNS:a.example');
		expect(
			Buffer.from(leaf.publicKey.export({ type: 'spki', format: 'der' })),
		).toEqual(
			Buffer.from(
				await crypto.subtle.exportKey('spki', certificateKey.publicKey),
			),
		);
	});
});
