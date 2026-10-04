import { afterAll, beforeAll, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { http01Responder } from '../challenge/responder';
import { createCsr } from '../csr/csr';
import { AcmeError } from '../errors';
import { generateKeyPair, type KeyType } from '../keys/keys';
import { AcmeClient } from './client';
import { obtainCertificate } from './obtain';
import {
	describePebble,
	HTTP01_PORT,
	PEBBLE_NAMES,
	type Pebble,
} from './pebble.fixtures';

const [A, B, C, D] = PEBBLE_NAMES;
const PROBLEM = 'urn:ietf:params:acme:error:';

/** The PEM blocks of a chain, each as an X509Certificate. */
function certificatesOf(chain: string): X509Certificate[] {
	return (
		chain.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ??
		[]
	).map((pem) => new X509Certificate(pem));
}

/** Checks a chain Pebble issued: the names, the certificate's key, and each certificate signed by the next. */
async function expectIssued(
	chain: string,
	names: string[],
	certificateKey: CryptoKeyPair,
) {
	const certificates = certificatesOf(chain);
	expect(certificates.length).toBeGreaterThanOrEqual(2);
	const [leaf, issuer] = certificates as [X509Certificate, X509Certificate];
	for (const name of names) {
		expect(leaf.subjectAltName).toContain(`DNS:${name}`);
		expect(leaf.checkHost(name)).toBe(name);
	}
	const spki = new Uint8Array(
		await crypto.subtle.exportKey('spki', certificateKey.publicKey),
	);
	expect(
		new Uint8Array(leaf.publicKey.export({ type: 'spki', format: 'der' })),
	).toEqual(spki);
	expect(leaf.checkIssued(issuer)).toBe(true);
	expect(leaf.verify(issuer.publicKey)).toBe(true);
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

describePebble('AcmeClient against Pebble', (pebble: Pebble) => {
	const responder = http01Responder();
	/** The paths Pebble's validation authority fetched. */
	const fetched: string[] = [];
	let server: ReturnType<typeof Bun.serve> | undefined;
	/** `badNonce` refusals Pebble sent (it refuses 5 % of nonces), each retried by the client. */
	let badNonces = 0;

	const countingFetch: Pebble['fetch'] = async (input, init) => {
		const answer = await pebble.fetch(input, init);
		if (answer.status === 400) {
			const problem = (await answer
				.clone()
				.json()
				.catch(() => ({}))) as { type?: string };
			if (problem.type === `${PROBLEM}badNonce`) badNonces++;
		}
		return answer;
	};

	async function clientWith(type: KeyType) {
		const client = new AcmeClient({
			directoryUrl: pebble.directoryUrl,
			accountKey: await generateKeyPair(type),
			fetch: countingFetch,
			pollIntervalMs: 100,
		});
		await client.newAccount({
			termsOfServiceAgreed: true,
			contact: ['mailto:admin@bumail.test'],
		});
		return client;
	}

	beforeAll(() => {
		// Pebble reaches the host through host-gateway, not loopback.
		server = Bun.serve({
			port: HTTP01_PORT,
			hostname: '0.0.0.0',
			fetch(request) {
				fetched.push(new URL(request.url).pathname);
				return responder.fetch(request);
			},
		});
	});
	afterAll(() => {
		server?.stop(true);
		console.log(
			`Pebble: ${fetched.length} HTTP-01 fetches answered, ${badNonces} badNonce refusals retried`,
		);
	});

	test('the whole flow issues a certificate for P-256 keys, Pebble validating HTTP-01 for real', async () => {
		const client = await clientWith('P-256');
		const certificateKey = await generateKeyPair('P-256');
		const before = fetched.length;
		const result = await obtainCertificate({
			client,
			names: [A, B],
			certificateKey,
			http01: responder,
		});
		expect(result.order.status).toBe('valid');
		await expectIssued(result.certificate, [A, B], certificateKey);
		expect(fetched.length).toBeGreaterThan(before);
		expect(responder.size).toBe(0);
	}, 60_000);

	test('the whole flow issues a certificate for RSA keys', async () => {
		const client = await clientWith('RSA-2048');
		const certificateKey = await generateKeyPair('RSA-2048');
		const result = await obtainCertificate({
			client,
			names: [C],
			certificateKey,
			http01: responder,
		});
		await expectIssued(result.certificate, [C], certificateKey);
		expect(responder.size).toBe(0);
	}, 60_000);

	test('each step, one call at a time', async () => {
		const client = await clientWith('P-256');
		const directory = await client.directory();
		expect(typeof directory.meta?.termsOfService).toBe('string');
		const kid = client.kid;
		expect(await client.newAccount({ onlyReturnExisting: true })).toBe(
			kid as string,
		);
		expect(await client.newNonce()).toMatch(/^[A-Za-z0-9_-]+$/);

		const certificateKey = await generateKeyPair('P-256');
		const csr = await createCsr({ names: [D], keyPair: certificateKey });
		let order = await client.newOrder({
			identifiers: [{ type: 'dns', value: D }],
		});
		expect(order.status).toBe('pending');
		const [url] = order.authorizations;
		const authorization = await client.authorization(url as string);
		expect(authorization.identifier).toEqual({ type: 'dns', value: D });
		const challenge = authorization.challenges.find(
			(c) => c.type === 'http-01',
		);
		const token = challenge?.token as string;
		responder.set(token, await client.keyAuthorization(token));
		try {
			await client.challenge(challenge?.url as string);
			expect((await client.waitForAuthorization(url as string)).status).toBe(
				'valid',
			);
		} finally {
			responder.remove(token);
		}
		order = await client.waitForOrder(order);
		expect(order.status).toBe('ready');
		order = await client.finalize(order, csr);
		order = await client.waitForOrder(order);
		expect(order.status).toBe('valid');
		const chain = await client.certificate(order.certificate as string);
		await expectIssued(chain, [D], certificateKey);
	}, 60_000);

	test('a wrong key authorization fails validation, and its token is removed', async () => {
		const client = await clientWith('P-256');
		const served = new Set<string>();
		const error = await rejection(
			obtainCertificate({
				client,
				names: [A],
				certificateKey: await generateKeyPair(),
				http01: {
					set(token) {
						served.add(token);
						responder.set(token, `${token}.not-the-thumbprint`);
					},
					remove(token) {
						served.delete(token);
						responder.remove(token);
					},
				},
			}),
		);
		expect(error.code).toBe('AUTHORIZATION_FAILED');
		expect(error.problem?.type).toBe(`${PROBLEM}unauthorized`);
		expect(served.size).toBe(0);
		expect(responder.size).toBe(0);
	}, 60_000);

	test('onlyReturnExisting for a key with no account is accountDoesNotExist', async () => {
		const client = new AcmeClient({
			directoryUrl: pebble.directoryUrl,
			accountKey: await generateKeyPair(),
			fetch: countingFetch,
		});
		const error = await rejection(
			client.newAccount({ onlyReturnExisting: true }),
		);
		expect(error.code).toBe('SERVER_PROBLEM');
		expect(error.problem?.type).toBe(`${PROBLEM}accountDoesNotExist`);
	});

	test('many requests in a row all succeed, Pebble refusing some nonces', async () => {
		const client = await clientWith('P-256');
		const order = await client.newOrder({
			identifiers: [{ type: 'dns', value: B }],
		});
		for (let i = 0; i < 60; i++) {
			expect((await client.order(order.url)).url).toBe(order.url);
		}
	}, 60_000);
});
