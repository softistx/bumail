import { type Csr, createCsr } from '../csr/csr';
import { shown } from '../encoding';
import { AcmeError } from '../errors';
import { jwkThumbprint } from '../jws/jwk';
import { isOptions } from './body';
import { checkLeaf } from './certificate';
import { AcmeClient } from './client';
import { abortedError } from './failure';
import { integerOption, MAX_WAIT_MS, signalOf } from './options';
import { type Http01Hooks, Http01Tokens } from './tokens';
import type { AcmeOrder } from './types';

const DEFAULT_TIMEOUT_MS = 300_000;
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
	const timeoutMs = integerOption(
		options.timeoutMs,
		'timeoutMs',
		where,
		1,
		MAX_WAIT_MS,
		DEFAULT_TIMEOUT_MS,
	);
	const caller = signalOf(options, where);
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
		return await run(client, csr, certificateKey, http01, signal, timeoutMs);
	} catch (thrown) {
		const { error, cleanup } =
			thrown instanceof Uncleaned
				? thrown
				: { error: thrown, cleanup: undefined };
		if (caller?.aborted) {
			throw withCleanup(abortedError(where, caller), cleanup);
		}
		if (deadline.aborted) {
			throw new AcmeError(
				'TIMEOUT',
				`${where}: no certificate within ${timeoutMs} ms`,
				{ cause: cleanup ?? error },
			);
		}
		if (cleanup !== undefined && error instanceof AcmeError) {
			throw error.cause === undefined ? withCleanup(error, cleanup) : error;
		}
		throw error;
	}
}

/** The flow's failure, and the cleanup's after it: the first is thrown, the second its `cause`. */
class Uncleaned {
	constructor(
		readonly error: unknown,
		readonly cleanup: unknown,
	) {}
}

/** `error` again, its code, message and problem kept, with `cleanup` as its `cause`. */
function withCleanup(error: AcmeError, cleanup: unknown): AcmeError {
	if (cleanup === undefined) return error;
	return new AcmeError(error.code, error.message, {
		cause: cleanup,
		...(error.problem === undefined ? {} : { problem: error.problem }),
		...(error.status === undefined ? {} : { status: error.status }),
		...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
	});
}

async function run(
	client: AcmeClient,
	csr: Csr,
	certificateKey: CryptoKeyPair,
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
	checkOrder(order, csr.names, where);
	const tokens = new Http01Tokens(http01);
	let failure: { error: unknown } | undefined;
	try {
		await validate(client, order, csr.names, tokens, signal, timeoutMs);
	} catch (error) {
		failure = { error };
	}
	const removed = await tokens.removeAll();
	if (failure !== undefined) {
		throw removed === undefined
			? failure.error
			: new Uncleaned(failure.error, removed.error);
	}
	if (removed !== undefined) throw removed.error;
	order = await client.waitForOrder(order, wait);
	if (order.status === 'valid') {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's order is "valid" before it was finalized`,
		);
	}
	order = await client.finalize(order, csr, { signal });
	if (order.status !== 'valid') order = await client.waitForOrder(order, wait);
	if (order.certificate === undefined) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's order is "valid" but has no "certificate"`,
		);
	}
	const certificate = await client.certificate(order.certificate, { signal });
	await checkLeaf(certificate, csr.names, certificateKey.publicKey, where);
	return { certificate, order, csr };
}

/**
 * Sets each pending authorization's `http-01` key authorization, answers
 * its challenge, then waits for every one to be `valid`.
 */
async function validate(
	client: AcmeClient,
	order: AcmeOrder,
	names: readonly string[],
	tokens: Http01Tokens,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<void> {
	const where = 'obtainCertificate()';
	const requested = new Set(names.map((name) => name.toLowerCase()));
	const pending: string[] = [];
	for (const url of order.authorizations) {
		const authorization = await client.authorization(url, { signal });
		const name = shown(authorization.identifier.value);
		if (
			authorization.identifier.type !== 'dns' ||
			!requested.has(authorization.identifier.value.toLowerCase())
		) {
			throw new AcmeError(
				'BAD_RESPONSE',
				`${where}: the CA's authorization is for ${name}, not one of the names requested`,
			);
		}
		if (authorization.status === 'valid') continue;
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
		await tokens.set(challenge.token, answer, signal);
		if (challenge.status === 'pending') {
			await client.challenge(challenge.url, { signal });
		}
		pending.push(url);
	}
	for (const url of pending) {
		await client.waitForAuthorization(url, { signal, timeoutMs });
	}
}

/**
 * Refuses, with `BAD_RESPONSE`, an order that is not for the names
 * requested (its identifiers, as DNS names, in any order), or that lists
 * more authorizations than names.
 */
function checkOrder(
	order: AcmeOrder,
	names: readonly string[],
	where: string,
): void {
	const got = order.identifiers
		.map((identifier) =>
			identifier.type === 'dns' ? identifier.value.toLowerCase() : '',
		)
		.sort();
	const wanted = [...names].sort();
	if (
		got.length !== wanted.length ||
		got.some((name, i) => name !== wanted[i])
	) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's order is for ${shown(order.identifiers.map((identifier) => identifier.value).join(', '))}, not the names requested`,
		);
	}
	if (order.authorizations.length > names.length) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's order lists ${order.authorizations.length} authorizations for ${names.length} names`,
		);
	}
}
