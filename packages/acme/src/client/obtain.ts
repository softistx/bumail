import { type Csr, createCsr } from '../csr/csr';
import { shown } from '../encoding';
import { AcmeError } from '../errors';
import { jwkThumbprint } from '../jws/jwk';
import { AcmeClient } from './client';
import { abortedError, isOptions } from './http';
import type { AcmeOrder } from './types';

const DEFAULT_TIMEOUT_MS = 300_000;

/** The hooks that publish an HTTP-01 answer: `http01Responder()` is one. */
export interface Http01Hooks {
	/** Serve `keyAuthorization` at `http://<name>/.well-known/acme-challenge/<token>`, on port 80. */
	set(token: string, keyAuthorization: string): void | Promise<void>;
	/** Stop serving it. Called for every token `set` was called with, whatever happened. */
	remove(token: string): void | Promise<void>;
}

/** Options of `obtainCertificate`. */
export interface ObtainCertificateOptions {
	/** A client whose account exists: `newAccount` called, or the `kid` option given. */
	client: AcmeClient;
	/** The DNS names, at most 100, the first one the CSR's CN; checked as `createCsr` does. */
	names: readonly string[];
	/** The certificate's key pair, never the account's. */
	certificateKey: CryptoKeyPair;
	/** Where the key authorizations are served. */
	http01: Http01Hooks;
	/** The whole flow's time limit, in ms: 1 to 3600000, 300000 by default. */
	timeoutMs?: number;
	/** Aborts the flow; the tokens set are still removed. */
	signal?: AbortSignal;
}

/** What `obtainCertificate` returns. */
export interface ObtainedCertificate {
	/** The PEM chain, the leaf first: Bun's TLS `cert`. */
	certificate: string;
	/** The order, `valid`. */
	order: AcmeOrder;
	/** The CSR sent. */
	csr: Csr;
}

/**
 * The whole HTTP-01 flow of RFC 8555 §7: a CSR for `names`, a new order,
 * each pending authorization's `http-01` challenge set through the hooks
 * and answered, the authorizations waited for, the order finalized and
 * waited for, and the chain downloaded. Every token set is removed once
 * the authorizations are settled, whether they succeeded or not; a
 * failure to remove is thrown only when nothing else failed.
 */
export async function obtainCertificate(
	options: ObtainCertificateOptions,
): Promise<ObtainedCertificate> {
	const where = 'obtainCertificate()';
	if (!isOptions(options)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: options must be an object`,
		);
	}
	const { client, names, certificateKey, http01 } = options;
	if (!(client instanceof AcmeClient)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: client must be an AcmeClient`,
		);
	}
	if (
		!isOptions(http01) ||
		typeof http01.set !== 'function' ||
		typeof http01.remove !== 'function'
	) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: http01 must be { set(token, keyAuthorization), remove(token) }`,
		);
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (
		typeof timeoutMs !== 'number' ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 3_600_000
	) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: timeoutMs must be an integer from 1 to 3600000, not ${shown(timeoutMs)}`,
		);
	}
	const caller = options.signal;
	if (caller !== undefined && !(caller instanceof AbortSignal)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: signal must be an AbortSignal`,
		);
	}
	if (client.kid === undefined) {
		throw new AcmeError(
			'NO_ACCOUNT',
			`${where}: the client has no account yet; call newAccount() first, or give the client its kid`,
		);
	}
	const csr = await createCsr({ names, keyPair: certificateKey });
	if (
		(await jwkThumbprint(certificateKey.publicKey)) ===
		(await client.accountThumbprint())
	) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where}: certificateKey is the account key; a certificate needs a key of its own`,
		);
	}
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
	try {
		return await run(client, csr, http01, signal, timeoutMs);
	} catch (error) {
		if (caller?.aborted) throw abortedError(where, caller);
		if (deadline.aborted) {
			throw new AcmeError(
				'TIMEOUT',
				`${where}: no certificate within ${timeoutMs} ms`,
				{ cause: error },
			);
		}
		throw error;
	}
}

async function run(
	client: AcmeClient,
	csr: Csr,
	http01: Http01Hooks,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<ObtainedCertificate> {
	const where = 'obtainCertificate()';
	const wait = { signal, timeoutMs };
	let order = await client.newOrder({
		identifiers: csr.names.map((value) => ({ type: 'dns', value })),
		signal,
	});
	const tokens: string[] = [];
	let failure: { error: unknown } | undefined;
	try {
		const pending: string[] = [];
		for (const url of order.authorizations) {
			const authorization = await client.authorization(url, { signal });
			if (authorization.status === 'valid') continue;
			const name = shown(authorization.identifier.value);
			if (authorization.status !== 'pending') {
				throw new AcmeError(
					'AUTHORIZATION_FAILED',
					`${where}: the authorization for ${name} is "${authorization.status}"`,
				);
			}
			const challenge = authorization.challenges.find(
				(item) => item.type === 'http-01',
			);
			if (challenge?.token === undefined) {
				throw new AcmeError(
					'AUTHORIZATION_FAILED',
					`${where}: the authorization for ${name} offers no http-01 challenge`,
				);
			}
			const answer = await client.keyAuthorization(challenge.token);
			tokens.push(challenge.token);
			await http01.set(challenge.token, answer);
			if (challenge.status === 'pending') {
				await client.challenge(challenge.url, { signal });
			}
			pending.push(url);
		}
		for (const url of pending) {
			await client.waitForAuthorization(url, wait);
		}
	} catch (error) {
		failure = { error };
	}
	const removed = await removeAll(http01, tokens);
	if (failure !== undefined) throw failure.error;
	if (removed !== undefined) throw removed.error;
	order = await client.waitForOrder(order, wait);
	if (order.status === 'ready') {
		order = await client.finalize(order, csr, { signal });
		if (order.status !== 'valid')
			order = await client.waitForOrder(order, wait);
	}
	if (order.certificate === undefined) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's order is "valid" but has no "certificate"`,
		);
	}
	const certificate = await client.certificate(order.certificate, { signal });
	return { certificate, order, csr };
}

/** Calls `remove` for every token, each in turn whatever the others did; the first failure, if any. */
async function removeAll(
	http01: Http01Hooks,
	tokens: string[],
): Promise<{ error: unknown } | undefined> {
	let first: { error: unknown } | undefined;
	for (const token of tokens) {
		try {
			await http01.remove(token);
		} catch (error) {
			first ??= { error };
		}
	}
	return first;
}
