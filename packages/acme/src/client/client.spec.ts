import { describe, expect, test } from 'bun:test';
import { createCsr } from '../csr/csr';
import { AcmeError } from '../errors';
import { generateKeyPair } from '../keys/keys';
import { issueCertificate, selfSignedCertificate } from '../keys/x509.fixtures';
import { MAX_CERTIFICATE_BYTES, MAX_JSON_BYTES } from './body';
import { AcmeClient } from './client';
import { BASE, FakeCa, PROBLEM } from './fake-ca.fixtures';
import { MAX_RETRY_AFTER } from './headers';
import { MAX_BAD_NONCE_RETRIES } from './transport';

const accountKey = await generateKeyPair();

function clientOf(ca: FakeCa, options: Record<string, unknown> = {}) {
	return new AcmeClient({
		directoryUrl: `${BASE}/dir`,
		accountKey,
		fetch: ca.fetch,
		pollIntervalMs: 10,
		...options,
	});
}

async function withAccount(ca = new FakeCa(), options = {}) {
	const client = clientOf(ca, options);
	await client.newAccount({ termsOfServiceAgreed: true });
	return { ca, client };
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

describe('the directory (RFC 8555 §7.1.1)', () => {
	test('is fetched once with a GET, and kept', async () => {
		const ca = new FakeCa();
		const client = clientOf(ca);
		const directory = await client.directory();
		expect(directory.newOrder).toBe(`${BASE}/order`);
		expect(directory.meta).toEqual({ termsOfService: `${BASE}/terms` });
		await client.directory();
		expect(ca.to('/dir').map((r) => r.method)).toEqual(['GET']);
	});

	test('a URL in it that is not https: is BAD_RESPONSE', async () => {
		const ca = new FakeCa();
		ca.routes.set('GET /dir', (_, fake) =>
			fake.json({
				newNonce: 'http://ca.test/nonce',
				newAccount: `${BASE}/account`,
				newOrder: `${BASE}/order`,
			}),
		);
		const error = await rejection(clientOf(ca).directory());
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`directory(): the CA's directory "newNonce" must be an https: URL without credentials or a fragment, not "http://ca.test/nonce"`,
		);
	});

	test('one that is not JSON, or misses a URL, is BAD_RESPONSE', async () => {
		const ca = new FakeCa();
		ca.routes.set('GET /dir', () => new Response('<html>'));
		expect((await rejection(clientOf(ca).directory())).message).toBe(
			"directory(): the CA's directory is not a JSON object",
		);
		ca.routes.set('GET /dir', (_, fake) =>
			fake.json({ newNonce: `${BASE}/n` }),
		);
		expect((await rejection(clientOf(ca).directory())).message).toBe(
			`directory(): the CA's directory "newAccount" must be an https: URL without credentials or a fragment, not undefined`,
		);
	});
});

describe('https only', () => {
	test.each([
		'http://ca.test/dir',
		'ftp://ca.test/dir',
		'https://user:pw@ca.test/dir',
		'https://ca.test/dir#x',
		'not a url',
	])('the directory URL %p is INVALID_OPTION', (directoryUrl) => {
		expect(() => new AcmeClient({ directoryUrl, accountKey })).toThrow(
			new AcmeError(
				'INVALID_OPTION',
				`AcmeClient: directoryUrl must be an https: URL without credentials or a fragment (http: only with allowInsecure), not ${JSON.stringify(directoryUrl)}`,
			),
		);
	});

	test('allowInsecure takes http:, for a test CA, and signs http: URLs', async () => {
		const ca = new FakeCa();
		ca.routes.set('GET /dir', (_, fake) =>
			fake.json({
				newNonce: 'http://ca.test/nonce',
				newAccount: 'http://ca.test/account',
				newOrder: 'http://ca.test/order',
			}),
		);
		ca.routes.set('POST /account', (_, fake) =>
			fake.json({ status: 'valid' }, 201, {
				location: 'http://ca.test/acct/1',
			}),
		);
		const client = clientOf(ca, {
			directoryUrl: 'http://ca.test/dir',
			allowInsecure: true,
		});
		expect(await client.newAccount()).toBe('http://ca.test/acct/1');
		expect(ca.to('/account')[0]?.header?.['url']).toBe(
			'http://ca.test/account',
		);
	});

	test('a Location that is not https: is BAD_RESPONSE', async () => {
		const ca = new FakeCa();
		ca.routes.set('POST /account', (_, fake) =>
			fake.json({}, 201, { location: 'http://ca.test/acct/1' }),
		);
		const error = await rejection(clientOf(ca).newAccount());
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`newAccount(): the CA's account URL (Location) must be an https: URL without credentials or a fragment, not "http://ca.test/acct/1"`,
		);
	});

	test('an order whose authorization URL is http: is BAD_RESPONSE', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.json(
				{
					status: 'pending',
					identifiers: [],
					authorizations: ['http://ca.test/authz/0'],
					finalize: `${BASE}/finalize/1`,
				},
				201,
				{ location: `${BASE}/order/1` },
			),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'example.com' }] }),
		);
		expect(error.message).toBe(
			`newOrder(): the CA's order "authorizations" must be an https: URL without credentials or a fragment, not "http://ca.test/authz/0"`,
		);
	});

	test('a redirect is not followed', async () => {
		const ca = new FakeCa();
		ca.routes.set(
			'GET /dir',
			() =>
				new Response(null, {
					status: 302,
					headers: { location: 'http://ca.test/dir' },
				}),
		);
		const error = await rejection(clientOf(ca).directory());
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			'directory(): the CA answered a redirect (302), which an ACME client does not follow',
		);
	});
});

describe('nonces (RFC 8555 §7.2, §6.5)', () => {
	test('newNonce is a HEAD; each answer’s Replay-Nonce signs the next request', async () => {
		const { ca, client } = await withAccount();
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		await client.authorization(`${BASE}/authz/0`);
		// The directory's answer gave the first one: no HEAD was needed.
		expect(ca.to('/nonce')).toEqual([]);
		const posts = ca.requests.filter((r) => r.method === 'POST');
		expect(posts.map((r) => r.header?.['nonce'])).toEqual([
			'nonce1',
			'nonce2',
			'nonce3',
		]);
		expect(await client.newNonce()).toBe('nonce5');
		expect(ca.to('/nonce').map((r) => r.method)).toEqual(['HEAD']);
	});

	test('with no nonce kept, one is fetched by a HEAD to newNonce', async () => {
		const ca = new FakeCa();
		ca.routes.set('GET /dir', (_, fake) => {
			const answer = fake.json({
				newNonce: `${BASE}/nonce`,
				newAccount: `${BASE}/account`,
				newOrder: `${BASE}/order`,
			});
			answer.headers.delete('replay-nonce');
			return answer;
		});
		await clientOf(ca).newAccount();
		expect(ca.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			'GET /dir',
			'HEAD /nonce',
			'POST /account',
		]);
	});

	test('badNonce is retried with the nonce it gave', async () => {
		const { ca, client } = await withAccount();
		let refusals = 2;
		ca.routes.set('POST /order', (_, fake) => {
			if (refusals-- > 0) return fake.problem('badNonce', 'stale nonce');
			fake.names = ['a.example'];
			return fake.json(fake.order(), 201, { location: `${BASE}/order/1` });
		});
		const order = await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		expect(order.status).toBe('pending');
		const nonces = ca.to('/order').map((r) => r.header?.['nonce']);
		expect(nonces).toEqual(['nonce2', 'nonce3', 'nonce4']);
	});

	test(`badNonce is retried ${MAX_BAD_NONCE_RETRIES} times, then thrown`, async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.problem('badNonce', 'stale nonce'),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'a.example' }] }),
		);
		expect(error.code).toBe('SERVER_PROBLEM');
		expect(error.problem?.type).toBe(`${PROBLEM}badNonce`);
		expect(ca.to('/order')).toHaveLength(1 + MAX_BAD_NONCE_RETRIES);
	});

	test('a Replay-Nonce that is not base64url is not kept', async () => {
		const ca = new FakeCa();
		ca.routes.set(
			'HEAD /nonce',
			() => new Response(null, { headers: { 'replay-nonce': 'a b' } }),
		);
		const error = await rejection(clientOf(ca).newNonce());
		expect(error.message).toBe(
			"newNonce(): the CA's newNonce answer has no valid Replay-Nonce",
		);
	});
});

describe('the account (RFC 8555 §7.3)', () => {
	test('newAccount signs with the jwk, returns the kid, and later requests carry it', async () => {
		const { ca, client } = await withAccount();
		const [request] = ca.to('/account');
		expect(request?.header?.['jwk']).toBeDefined();
		expect(request?.header?.['kid']).toBeUndefined();
		expect(request?.payload).toEqual({ termsOfServiceAgreed: true });
		expect(client.kid).toBe(`${BASE}/acct/1`);
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		const [order] = ca.to('/order');
		expect(order?.header?.['kid']).toBe(`${BASE}/acct/1`);
		expect(order?.header?.['jwk']).toBeUndefined();
	});

	test('contact and onlyReturnExisting are sent as given', async () => {
		const ca = new FakeCa();
		await clientOf(ca).newAccount({
			contact: ['mailto:admin@example.com'],
			onlyReturnExisting: true,
		});
		expect(ca.to('/account')[0]?.payload).toEqual({
			contact: ['mailto:admin@example.com'],
			onlyReturnExisting: true,
		});
	});

	test.each([
		[
			{ contact: 'mailto:a@example.com' },
			'newAccount(): contact must be an array of at most 10 mailto: URLs, not "mailto:a@example.com"',
		],
		[
			{ contact: ['https://example.com'] },
			'newAccount(): a contact is a mailto: URL with one address, not "https://example.com"',
		],
		[
			{ termsOfServiceAgreed: 'yes' },
			'newAccount(): termsOfServiceAgreed must be a boolean',
		],
	])('%p is INVALID_OPTION', async (options, message) => {
		const error = await rejection(
			clientOf(new FakeCa()).newAccount(options as never),
		);
		expect(error.code).toBe('INVALID_OPTION');
		expect(error.message).toBe(message);
	});

	test('the kid option skips newAccount', async () => {
		const ca = new FakeCa();
		const client = clientOf(ca, { kid: `${BASE}/acct/9` });
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		expect(ca.to('/order')[0]?.header?.['kid']).toBe(`${BASE}/acct/9`);
	});

	test('a request that needs the account before there is one is NO_ACCOUNT', async () => {
		const error = await rejection(
			clientOf(new FakeCa()).authorization(`${BASE}/authz/0`),
		);
		expect(error.code).toBe('NO_ACCOUNT');
		expect(error.message).toBe(
			'authorization(): no account yet; call newAccount() first, or give the client its kid',
		);
	});
});

describe('POST-as-GET (RFC 8555 §6.3)', () => {
	test('fetching an order, an authorization or a certificate sends an empty payload; a challenge sends {}', async () => {
		const { ca, client } = await withAccount();
		const order = await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		const authorization = await client.authorization(
			order.authorizations[0] ?? '',
		);
		expect(authorization.identifier).toEqual({
			type: 'dns',
			value: 'a.example',
		});
		const challenge = authorization.challenges[0];
		expect(challenge?.type).toBe('http-01');
		await client.challenge(challenge?.url ?? '');
		await client.order(order.url);
		const csr = await createCsr({
			names: ['a.example'],
			keyPair: await generateKeyPair(),
		});
		const finalized = await client.finalize(order, csr);
		expect(finalized.status).toBe('valid');
		expect(await client.certificate(finalized.certificate ?? '')).toBe(
			ca.chain ?? '',
		);
		expect(ca.to('/authz/0')[0]?.payload).toBe('');
		expect(ca.to('/chall/0/http-01')[0]?.payload).toEqual({});
		expect(ca.to('/order/1')[0]?.payload).toBe('');
		expect(ca.to('/finalize/1')[0]?.payload).toEqual({
			csr: Buffer.from(csr.der).toString('base64url'),
		});
		const [cert] = ca.to('/cert/1');
		expect(cert?.payload).toBe('');
		expect(cert?.headers.get('accept')).toBe(
			'application/pem-certificate-chain',
		);
		for (const request of ca.requests.filter((r) => r.method === 'POST')) {
			expect(request.header?.['url']).toBe(request.url);
			expect(request.headers.get('content-type')).toBe('application/jose+json');
		}
	});
});

describe('problem documents (RFC 8555 §6.7)', () => {
	test('an error is SERVER_PROBLEM, with the type, detail and status', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.problem(
				'rejectedIdentifier',
				'policy forbids issuing for name',
				400,
				{},
				{
					subproblems: [
						{
							type: `${PROBLEM}rejectedIdentifier`,
							detail: 'forbidden',
							identifier: { type: 'dns', value: 'bad.example' },
						},
					],
				},
			),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'bad.example' }] }),
		);
		expect(error.code).toBe('SERVER_PROBLEM');
		expect(error.status).toBe(400);
		expect(error.problem?.type).toBe(`${PROBLEM}rejectedIdentifier`);
		expect(error.problem?.subproblems?.[0]?.identifier?.value).toBe(
			'bad.example',
		);
		expect(error.message).toBe(
			`newOrder(): the CA answered 400: ${PROBLEM}rejectedIdentifier: policy forbids issuing for name (bad.example: forbidden)`,
		);
	});

	test('an error status with no problem document is SERVER_PROBLEM all the same', async () => {
		const ca = new FakeCa();
		ca.routes.set(
			'GET /dir',
			() => new Response('Bad gateway', { status: 502 }),
		);
		const error = await rejection(clientOf(ca).directory());
		expect(error.code).toBe('SERVER_PROBLEM');
		expect(error.status).toBe(502);
		expect(error.message).toBe(
			'directory(): the CA answered 502 without a problem document',
		);
	});

	test('a detail is put on one line and cut, so the CA cannot forge log lines', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.problem('malformed', `line one\nline two${'x'.repeat(2000)}`),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'a.example' }] }),
		);
		expect(error.message).not.toContain('\n');
		expect(error.message.length).toBeLessThan(400);
		expect(error.problem?.detail?.length).toBeLessThanOrEqual(1025);
	});

	test('rateLimited is RATE_LIMITED, with Retry-After in seconds', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.problem('rateLimited', 'too many certificates', 429, {
				'retry-after': '3600',
			}),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'a.example' }] }),
		);
		expect(error.code).toBe('RATE_LIMITED');
		expect(error.retryAfter).toBe(3600);
		expect(error.status).toBe(429);
		expect(error.message).toBe(
			`newOrder(): the CA's rate limit: ${PROBLEM}rateLimited: too many certificates (retry after 3600 s)`,
		);
	});

	test.each([
		['99999999999', MAX_RETRY_AFTER],
		['-5', 0],
		[new Date(Date.now() - 60_000).toUTCString(), 0],
		['soon', undefined],
	])('Retry-After %p is clamped to %p', async (header, expected) => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.problem('rateLimited', 'slow down', 429, { 'retry-after': header }),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'a.example' }] }),
		);
		expect(error.retryAfter).toBe(expected as never);
	});

	test('an HTTP date in Retry-After is turned into seconds', async () => {
		const { ca, client } = await withAccount();
		const at = new Date(Date.now() + 120_000).toUTCString();
		ca.routes.set('POST /order', (_, fake) =>
			fake.problem('rateLimited', 'slow down', 429, { 'retry-after': at }),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'a.example' }] }),
		);
		expect(error.retryAfter).toBeGreaterThanOrEqual(118);
		expect(error.retryAfter).toBeLessThanOrEqual(121);
	});
});

describe('polling', () => {
	async function pendingOrder() {
		const { ca, client } = await withAccount();
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		return { ca, client };
	}

	test('waits as Retry-After says, then returns the valid authorization', async () => {
		const { ca, client } = await pendingOrder();
		let polls = 0;
		ca.routes.set('POST /authz/0', (_, fake) => {
			polls++;
			if (polls === 2) fake.authorizations[0] = 'valid';
			return fake.json(fake.authorization(0), 200, { 'retry-after': '1' });
		});
		const started = performance.now();
		const authorization = await client.waitForAuthorization(`${BASE}/authz/0`);
		expect(authorization.status).toBe('valid');
		expect(polls).toBe(2);
		expect(performance.now() - started).toBeGreaterThanOrEqual(950);
	});

	test('without Retry-After it waits pollIntervalMs', async () => {
		const { ca, client } = await pendingOrder();
		let polls = 0;
		ca.routes.set('POST /authz/0', (_, fake) => {
			if (++polls === 5) fake.authorizations[0] = 'valid';
			return fake.json(fake.authorization(0));
		});
		const started = performance.now();
		await client.waitForAuthorization(`${BASE}/authz/0`);
		expect(polls).toBe(5);
		expect(performance.now() - started).toBeLessThan(900);
	});

	test('a Retry-After past a minute is clamped to one, and the overall timeout still holds', async () => {
		const { ca, client } = await pendingOrder();
		ca.routes.set('POST /authz/0', (_, fake) =>
			fake.json(fake.authorization(0), 200, { 'retry-after': '86400' }),
		);
		const started = performance.now();
		const error = await rejection(
			client.waitForAuthorization(`${BASE}/authz/0`, { timeoutMs: 200 }),
		);
		expect(error.code).toBe('TIMEOUT');
		expect(error.message).toBe(
			'waitForAuthorization(): still "pending" after 200 ms',
		);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test('an invalid authorization is AUTHORIZATION_FAILED, with its challenge’s problem', async () => {
		const { ca, client } = await pendingOrder();
		ca.routes.set('POST /authz/0', (_, fake) => {
			const authorization = fake.authorization(0);
			authorization['status'] = 'invalid';
			(authorization['challenges'] as Record<string, unknown>[])[0] = {
				type: 'http-01',
				url: `${BASE}/chall/0/http-01`,
				status: 'invalid',
				token: 'token0',
				error: {
					type: `${PROBLEM}unauthorized`,
					detail: 'The key authorization file from the server did not match',
					status: 403,
				},
			};
			return fake.json(authorization);
		});
		const error = await rejection(
			client.waitForAuthorization(`${BASE}/authz/0`),
		);
		expect(error.code).toBe('AUTHORIZATION_FAILED');
		expect(error.problem?.type).toBe(`${PROBLEM}unauthorized`);
		expect(error.message).toBe(
			`waitForAuthorization(): the authorization for "a.example" is "invalid": ${PROBLEM}unauthorized: The key authorization file from the server did not match`,
		);
	});

	test('an invalid order is ORDER_FAILED, with its problem', async () => {
		const { ca, client } = await pendingOrder();
		ca.routes.set('POST /order/1', (_, fake) =>
			fake.json({
				...fake.order(),
				status: 'invalid',
				error: { type: `${PROBLEM}badCSR`, detail: 'bad key' },
			}),
		);
		const error = await rejection(client.waitForOrder(`${BASE}/order/1`));
		expect(error.code).toBe('ORDER_FAILED');
		expect(error.message).toBe(
			`waitForOrder(): the order is "invalid": ${PROBLEM}badCSR: bad key`,
		);
	});

	test('waitForOrder takes the order itself, and returns once it is ready', async () => {
		const { ca, client } = await pendingOrder();
		let polls = 0;
		ca.routes.set('POST /order/1', (_, fake) => {
			if (++polls === 3) fake.orderStatus = 'ready';
			return fake.json(fake.order());
		});
		const order = await client.order(`${BASE}/order/1`);
		expect((await client.waitForOrder(order)).status).toBe('ready');
	});
});

describe('aborting and time limits', () => {
	test('an aborted signal is ABORTED before any request', async () => {
		const ca = new FakeCa();
		const error = await rejection(
			clientOf(ca).directory({ signal: AbortSignal.abort() }),
		);
		expect(error.code).toBe('ABORTED');
		expect(error.message).toBe('directory(): aborted');
		expect(ca.requests).toHaveLength(0);
	});

	test('aborting a wait between two polls is ABORTED at once', async () => {
		const { ca, client } = await withAccount();
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		ca.routes.set('POST /authz/0', (_, fake) =>
			fake.json(fake.authorization(0), 200, { 'retry-after': '30' }),
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error('shutting down')), 50);
		const started = performance.now();
		const error = await rejection(
			client.waitForAuthorization(`${BASE}/authz/0`, {
				signal: controller.signal,
			}),
		);
		expect(error.code).toBe('ABORTED');
		expect((error.cause as Error).message).toBe('shutting down');
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test('aborting a request in flight is ABORTED', async () => {
		const controller = new AbortController();
		const client = new AcmeClient({
			directoryUrl: `${BASE}/dir`,
			accountKey,
			fetch: (_, init) =>
				new Promise((_, reject) =>
					init.signal?.addEventListener('abort', () =>
						reject(init.signal?.reason),
					),
				),
		});
		setTimeout(() => controller.abort(), 20);
		const error = await rejection(
			client.directory({ signal: controller.signal }),
		);
		expect(error.code).toBe('ABORTED');
	});

	test('a signal from AbortSignal.timeout is TIMEOUT', async () => {
		const client = new AcmeClient({
			directoryUrl: `${BASE}/dir`,
			accountKey,
			fetch: (_, init) =>
				new Promise((_, reject) =>
					init.signal?.addEventListener('abort', () =>
						reject(init.signal?.reason),
					),
				),
		});
		const error = await rejection(
			client.directory({ signal: AbortSignal.timeout(20) }),
		);
		expect(error.code).toBe('TIMEOUT');
		expect(error.message).toBe('directory(): the signal timed out');
	});

	test('a request with no answer within requestTimeoutMs is TIMEOUT', async () => {
		const client = new AcmeClient({
			directoryUrl: `${BASE}/dir`,
			accountKey,
			requestTimeoutMs: 30,
			fetch: (_, init) =>
				new Promise((_, reject) =>
					init.signal?.addEventListener('abort', () =>
						reject(init.signal?.reason),
					),
				),
		});
		const error = await rejection(client.directory());
		expect(error.code).toBe('TIMEOUT');
		expect(error.message).toBe('directory(): no answer within 30 ms');
	});

	test('a fetch that fails is NETWORK_ERROR', async () => {
		const client = new AcmeClient({
			directoryUrl: `${BASE}/dir`,
			accountKey,
			fetch: () => Promise.reject(new TypeError('Unable to connect')),
		});
		const error = await rejection(client.directory());
		expect(error.code).toBe('NETWORK_ERROR');
		expect(error.message).toBe('directory(): fetch failed: Unable to connect');
	});
});

describe('size caps', () => {
	test('a JSON answer over the cap, by its Content-Length, is refused unread', async () => {
		const ca = new FakeCa();
		ca.routes.set(
			'GET /dir',
			() =>
				new Response('{}', {
					headers: { 'content-length': String(MAX_JSON_BYTES + 1) },
				}),
		);
		const error = await rejection(clientOf(ca).directory());
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`directory(): the CA's answer is over ${MAX_JSON_BYTES} bytes`,
		);
	});

	test('a streamed answer over the cap is cut off while reading', async () => {
		const ca = new FakeCa();
		let pulled = 0;
		ca.routes.set(
			'GET /dir',
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							pulled++;
							controller.enqueue(new Uint8Array(64 * 1024));
						},
					}),
				),
		);
		const error = await rejection(clientOf(ca).directory());
		expect(error.message).toBe(
			`directory(): the CA's answer is over ${MAX_JSON_BYTES} bytes`,
		);
		expect(pulled).toBeLessThan(10);
	});

	test('a certificate over 1 MiB is refused', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set(
			'POST /cert/1',
			(_, fake) =>
				new Response('A'.repeat(MAX_CERTIFICATE_BYTES + 1), {
					headers: { 'replay-nonce': fake.nonce() },
				}),
		);
		const error = await rejection(client.certificate(`${BASE}/cert/1`));
		expect(error.message).toBe(
			`certificate(): the CA's answer is over ${MAX_CERTIFICATE_BYTES} bytes`,
		);
	});

	test('a certificate that is not a PEM chain is BAD_RESPONSE', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /cert/1', (_, fake) =>
			fake.json({ certificate: 'no' }),
		);
		const error = await rejection(client.certificate(`${BASE}/cert/1`));
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			"certificate(): the CA's answer is not a PEM certificate chain",
		);
	});

	test('a PEM block that is not an X.509 certificate is BAD_RESPONSE', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set(
			'POST /cert/1',
			(_, fake) =>
				new Response(
					`-----BEGIN CERTIFICATE-----\n${'QUJD'.repeat(16)}\n-----END CERTIFICATE-----\n`,
					{ headers: { 'replay-nonce': fake.nonce() } },
				),
		);
		const error = await rejection(client.certificate(`${BASE}/cert/1`));
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			"certificate(): the CA's chain holds a block that is not an X.509 certificate",
		);
	});

	test('a chain not in order, each issued by the next, is BAD_RESPONSE', async () => {
		const { ca, client } = await withAccount();
		const rootKey = await generateKeyPair();
		const leafKey = await generateKeyPair();
		const root = await selfSignedCertificate(rootKey, 'Root');
		const leaf = await issueCertificate({
			spki: new Uint8Array(
				await crypto.subtle.exportKey('spki', leafKey.publicKey),
			),
			names: ['a.example'],
			subject: 'a.example',
			issuer: 'Root',
			signer: rootKey.privateKey,
		});
		const serve = (chain: string) =>
			ca.routes.set(
				'POST /cert/1',
				(_, fake) =>
					new Response(chain, { headers: { 'replay-nonce': fake.nonce() } }),
			);
		serve(`${leaf}${root}`);
		expect(await client.certificate(`${BASE}/cert/1`)).toBe(`${leaf}${root}`);
		serve(`${root}${leaf}`);
		const error = await rejection(client.certificate(`${BASE}/cert/1`));
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			"certificate(): the CA's chain is not in order, each certificate issued by the next",
		);
	});
});

describe('the account key', () => {
	test('is shown nowhere: not by inspect, JSON or an error', async () => {
		const jwk = await crypto.subtle.exportKey('jwk', accountKey.privateKey);
		const client = clientOf(new FakeCa());
		expect(Bun.inspect(client)).toBe('AcmeClient {}');
		expect(JSON.stringify(client)).toBe('{}');
		expect(Object.keys(client)).toEqual([]);
		const error = await rejection(client.authorization(`${BASE}/authz/0`));
		expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
			jwk.d ?? '?',
		);
	});

	test('a key of another algorithm is INVALID_KEY', async () => {
		const ed = (await crypto.subtle.generateKey('Ed25519', true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		expect(
			() => new AcmeClient({ directoryUrl: `${BASE}/dir`, accountKey: ed }),
		).toThrow(
			'AcmeClient: accountKey.privateKey is Ed25519; only ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 are supported',
		);
	});
});

describe('options', () => {
	test.each([
		[
			{ requestTimeoutMs: 0 },
			'AcmeClient: requestTimeoutMs must be an integer from 1 to 600000, not number',
		],
		[
			{ pollIntervalMs: 5 },
			'AcmeClient: pollIntervalMs must be an integer from 10 to 60000, not number',
		],
		[{ allowInsecure: 'yes' }, 'AcmeClient: allowInsecure must be a boolean'],
		[{ fetch: 'fetch' }, 'AcmeClient: fetch must be a function'],
		[
			{ kid: 'http://ca.test/acct/1' },
			'AcmeClient: kid must be an https: URL without credentials or a fragment (http: only with allowInsecure), not "http://ca.test/acct/1"',
		],
	])('%p is INVALID_OPTION', (options, message) => {
		expect(
			() =>
				new AcmeClient({
					directoryUrl: `${BASE}/dir`,
					accountKey,
					...(options as object),
				}),
		).toThrow(new AcmeError('INVALID_OPTION', message));
	});

	test('identifiers are checked before anything is sent', async () => {
		const { ca, client } = await withAccount();
		const before = ca.requests.length;
		for (const identifiers of [
			[],
			'a.example',
			[{ type: 'dns', value: 'a b' }],
		]) {
			const error = await rejection(client.newOrder({ identifiers } as never));
			expect(error.code).toBe('INVALID_OPTION');
		}
		expect(ca.requests).toHaveLength(before);
	});

	test('finalize takes a Csr or its DER, nothing else', async () => {
		const { client } = await withAccount();
		const order = await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		const error = await rejection(client.finalize(order, 'csr' as never));
		expect(error.message).toBe(
			'finalize(): csr must be a Csr from createCsr() or its DER bytes',
		);
	});

	test('a wait timeout out of range is INVALID_OPTION', async () => {
		const { client } = await withAccount();
		const error = await rejection(
			client.waitForOrder(`${BASE}/order/1`, { timeoutMs: 0 }),
		);
		expect(error.message).toBe(
			'waitForOrder(): timeoutMs must be an integer from 1 to 3600000, not number',
		);
	});
});

describe('AcmeClient: what the CA answers, checked and bounded', () => {
	test('finalize answered "invalid" is ORDER_FAILED', async () => {
		const { ca, client } = await withAccount();
		const order = await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		ca.routes.set('POST /finalize/1', (_, fake) =>
			fake.json({
				...fake.order(),
				status: 'invalid',
				error: { type: `${PROBLEM}badCSR`, detail: 'key too weak' },
			}),
		);
		const csr = await createCsr({
			names: ['a.example'],
			keyPair: await generateKeyPair(),
		});
		const error = await rejection(client.finalize(order, csr));
		expect(error.code).toBe('ORDER_FAILED');
		expect(error.message).toBe(
			`finalize(): the order is "invalid": ${PROBLEM}badCSR: key too weak`,
		);
	});

	test('a Retry-After shorter than pollIntervalMs waits pollIntervalMs', async () => {
		const { ca, client } = await withAccount(new FakeCa(), {
			pollIntervalMs: 300,
		});
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		let polls = 0;
		ca.routes.set('POST /authz/0', (_, fake) => {
			if (++polls === 2) fake.authorizations[0] = 'valid';
			return fake.json(fake.authorization(0), 200, { 'retry-after': '0' });
		});
		const started = performance.now();
		await client.waitForAuthorization(`${BASE}/authz/0`);
		expect(performance.now() - started).toBeGreaterThanOrEqual(280);
	});

	test('a token that is not base64url is the CA’s fault: BAD_RESPONSE', async () => {
		const { ca, client } = await withAccount();
		await client.newOrder({
			identifiers: [{ type: 'dns', value: 'a.example' }],
		});
		ca.routes.set('POST /authz/0', (_, fake) => {
			const authorization = fake.authorization(0);
			(authorization['challenges'] as Record<string, unknown>[])[0] = {
				type: 'http-01',
				url: `${BASE}/chall/0/http-01`,
				status: 'pending',
				token: 'bad token/../x',
			};
			return fake.json(authorization);
		});
		const error = await rejection(client.authorization(`${BASE}/authz/0`));
		expect(error.code).toBe('BAD_RESPONSE');
		expect(error.message).toBe(
			`authorization(): the CA's challenge has a missing or invalid "token"`,
		);
	});

	test('meta text with control characters is dropped', async () => {
		const ca = new FakeCa();
		ca.routes.set('GET /dir', (_, fake) =>
			fake.json({
				newNonce: `${BASE}/nonce`,
				newAccount: `${BASE}/account`,
				newOrder: `${BASE}/order`,
				meta: {
					termsOfService: 'https://ca.test/terms\nforged',
					website: 'https://ca.test',
				},
			}),
		);
		expect((await clientOf(ca).directory()).meta).toEqual({
			website: 'https://ca.test',
		});
	});

	test('an order identifier over its length caps is BAD_RESPONSE', async () => {
		const { ca, client } = await withAccount();
		ca.routes.set('POST /order', (_, fake) =>
			fake.json(
				{
					...fake.order(),
					identifiers: [{ type: 'dns', value: 'a'.repeat(300) }],
				},
				201,
				{ location: `${BASE}/order/1` },
			),
		);
		const error = await rejection(
			client.newOrder({ identifiers: [{ type: 'dns', value: 'a.example' }] }),
		);
		expect(error.message).toBe(
			`newOrder(): the CA's order has a missing or invalid "identifiers"`,
		);
	});

	test('callers asking for the directory at once share one GET', async () => {
		const ca = new FakeCa();
		const client = clientOf(ca);
		await Promise.all([
			client.directory(),
			client.directory(),
			client.newNonce(),
		]);
		expect(ca.to('/dir')).toHaveLength(1);
	});

	test('one caller aborting does not fail another waiting on the same directory', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ca = new FakeCa();
		const slow: typeof ca.fetch = async (input, init) => {
			if (input.endsWith('/dir')) await gate;
			return await ca.fetch(input, init);
		};
		const client = new AcmeClient({
			directoryUrl: `${BASE}/dir`,
			accountKey,
			fetch: slow,
		});
		const controller = new AbortController();
		const first = rejection(client.directory({ signal: controller.signal }));
		const second = client.directory();
		controller.abort();
		expect((await first).code).toBe('ABORTED');
		release();
		expect((await second).newOrder).toBe(`${BASE}/order`);
	});
});
