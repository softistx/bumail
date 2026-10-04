import { keyAuthorization } from '../challenge/http01';
import type { Csr } from '../csr/csr';
import { base64url } from '../encoding';
import { AcmeError } from '../errors';
import { jwkThumbprint } from '../jws/jwk';
import { algorithmOf, expectType } from '../keys/algorithm';
import {
	abortedError,
	callerUrl,
	isOptions,
	MAX_CERTIFICATE_BYTES,
	retryAfter,
	serverUrl,
	sleep,
} from './http';
import {
	type AcmeClientOptions,
	type AcmeRequestOptions,
	type AcmeWaitOptions,
	accountPayload,
	checkOptions,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	DEFAULT_WAIT_TIMEOUT_MS,
	identifiersOf,
	integerOption,
	MAX_POLL_DELAY_MS,
	MAX_WAIT_MS,
	type NewAccountOptions,
	type NewOrderOptions,
	signalOf,
} from './options';
import {
	authorizationFailed,
	authorizationOf,
	challengeOf,
	orderFailed,
	orderOf,
} from './resources';
import { jsonOf, Transport } from './transport';
import type {
	AcmeAuthorization,
	AcmeChallenge,
	AcmeDirectory,
	AcmeOrder,
} from './types';

/** One certificate or more, in PEM, nothing else. */
const PEM_CHAIN =
	/^(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n*)+$/;

/** What one poll found: the resource when it is done, or the CA's `Retry-After` and the state it is still in. */
type PollStep<T> = { done: T } | { after: number | undefined; state: string };

/**
 * A client of an ACME server (RFC 8555): the directory, nonces, the
 * account, orders, authorizations, challenges, finalize and the
 * certificate. Every request but the directory and `newNonce` is a JWS
 * signed with the account key and POSTed, a fetch being a POST-as-GET.
 * Every URL, given or answered, must be `https:`; every answer is read up
 * to a size cap; every number from the CA is clamped. The account key is
 * kept in a private field and appears in no message.
 */
export class AcmeClient {
	readonly #transport: Transport;
	readonly #pollIntervalMs: number;
	#kid: string | undefined;

	constructor(options: AcmeClientOptions) {
		const where = 'AcmeClient';
		checkOptions(options, where);
		const allowInsecure = options.allowInsecure ?? false;
		if (typeof allowInsecure !== 'boolean') {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: allowInsecure must be a boolean`,
			);
		}
		const directoryUrl = callerUrl(
			options.directoryUrl,
			'directoryUrl',
			where,
			allowInsecure,
		);
		const accountKey = accountKeyOf(options.accountKey, where);
		const fetch = options.fetch ?? globalThis.fetch;
		if (typeof fetch !== 'function') {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: fetch must be a function`,
			);
		}
		if (options.kid !== undefined) {
			this.#kid = callerUrl(options.kid, 'kid', where, allowInsecure);
		}
		const requestTimeoutMs = integerOption(
			options.requestTimeoutMs,
			'requestTimeoutMs',
			where,
			1,
			600_000,
			DEFAULT_REQUEST_TIMEOUT_MS,
		);
		this.#pollIntervalMs = integerOption(
			options.pollIntervalMs,
			'pollIntervalMs',
			where,
			10,
			MAX_POLL_DELAY_MS,
			DEFAULT_POLL_INTERVAL_MS,
		);
		this.#transport = new Transport({
			directoryUrl,
			accountKey,
			fetch,
			allowInsecure,
			requestTimeoutMs,
		});
	}

	/** The account URL, the `kid` of every signed request: set by `newAccount` or the option. */
	get kid(): string | undefined {
		return this.#kid;
	}

	/** The directory (RFC 8555 §7.1.1), fetched once with a GET and kept. */
	async directory(options: AcmeRequestOptions = {}): Promise<AcmeDirectory> {
		const where = 'directory()';
		return await this.#transport.directory(where, signalOf(options, where));
	}

	/**
	 * A fresh nonce from `newNonce` (RFC 8555 §7.2), by a HEAD. The client
	 * gets its own as it needs them, and keeps each `Replay-Nonce` an answer
	 * gives for the next request; this one is for signing a request yourself.
	 */
	async newNonce(options: AcmeRequestOptions = {}): Promise<string> {
		const where = 'newNonce()';
		return await this.#transport.newNonce(where, signalOf(options, where));
	}

	/**
	 * Creates the account of the account key, or finds it (RFC 8555 §7.3),
	 * and returns its URL, kept as the `kid` of later requests.
	 */
	async newAccount(options: NewAccountOptions = {}): Promise<string> {
		const where = 'newAccount()';
		const signal = signalOf(options, where);
		const payload = accountPayload(options, where);
		const { newAccount } = await this.#transport.directory(where, signal);
		const answer = await this.#transport.post(where, newAccount, payload, {
			signal,
			kid: undefined,
		});
		const kid = serverUrl(
			answer.headers.get('location') ?? undefined,
			'account URL (Location)',
			where,
			this.#transport.allowInsecure,
		);
		jsonOf(answer, where, 'account');
		this.#kid = kid;
		return kid;
	}

	/** Orders a certificate for `identifiers` (RFC 8555 §7.4): the order, with its URL. */
	async newOrder(options: NewOrderOptions): Promise<AcmeOrder> {
		const where = 'newOrder()';
		const signal = signalOf(options, where);
		const identifiers = identifiersOf(options.identifiers, where);
		const kid = this.#account(where);
		const { newOrder } = await this.#transport.directory(where, signal);
		const answer = await this.#transport.post(
			where,
			newOrder,
			{ identifiers },
			{ signal, kid },
		);
		const url = serverUrl(
			answer.headers.get('location') ?? undefined,
			'order URL (Location)',
			where,
			this.#transport.allowInsecure,
		);
		return orderOf(
			jsonOf(answer, where, 'order'),
			url,
			where,
			this.#transport.allowInsecure,
		);
	}

	/** Fetches an order again, by a POST-as-GET (RFC 8555 §7.4). */
	async order(
		url: string,
		options: AcmeRequestOptions = {},
	): Promise<AcmeOrder> {
		const where = 'order()';
		return (await this.#getOrder(where, url, signalOf(options, where))).order;
	}

	/** Fetches an authorization, by a POST-as-GET (RFC 8555 §7.5). */
	async authorization(
		url: string,
		options: AcmeRequestOptions = {},
	): Promise<AcmeAuthorization> {
		const where = 'authorization()';
		return (await this.#getAuthorization(where, url, signalOf(options, where)))
			.authorization;
	}

	/**
	 * Tells the CA a challenge is ready to be validated, by POSTing `{}` to
	 * its URL (RFC 8555 §7.5.1): serve the key authorization first. Returns
	 * the challenge as the CA answers it, `processing` most often; then wait
	 * for the authorization with `waitForAuthorization`.
	 */
	async challenge(
		url: string,
		options: AcmeRequestOptions = {},
	): Promise<AcmeChallenge> {
		const where = 'challenge()';
		const signal = signalOf(options, where);
		const target = this.#url(url, where);
		const kid = this.#account(where);
		const answer = await this.#transport.post(
			where,
			target,
			{},
			{
				signal,
				kid,
			},
		);
		return challengeOf(
			jsonOf(answer, where, 'challenge'),
			where,
			this.#transport.allowInsecure,
		);
	}

	/**
	 * Polls an authorization until it is `valid`, waiting as the CA's
	 * `Retry-After` says (clamped from `pollIntervalMs` to a minute):
	 * `AUTHORIZATION_FAILED` once it is anything but `pending` or `valid`,
	 * with the failed challenge's problem; `TIMEOUT` after `timeoutMs`.
	 */
	async waitForAuthorization(
		url: string,
		options: AcmeWaitOptions = {},
	): Promise<AcmeAuthorization> {
		const where = 'waitForAuthorization()';
		return await this.#poll(where, options, async (signal) => {
			const { authorization, after } = await this.#getAuthorization(
				where,
				url,
				signal,
			);
			if (authorization.status === 'valid') return { done: authorization };
			if (authorization.status !== 'pending') {
				throw authorizationFailed(where, authorization);
			}
			return { after, state: '"pending"' };
		});
	}

	/**
	 * Polls an order until it is `ready` (its authorizations valid) or
	 * `valid` (its certificate issued), waiting as `waitForAuthorization`
	 * does: `ORDER_FAILED` once it is `invalid`, with its problem.
	 */
	async waitForOrder(
		order: string | AcmeOrder,
		options: AcmeWaitOptions = {},
	): Promise<AcmeOrder> {
		const where = 'waitForOrder()';
		const url = isOptions(order) ? (order as AcmeOrder).url : order;
		return await this.#poll(where, options, async (signal) => {
			const { order: current, after } = await this.#getOrder(
				where,
				url as string,
				signal,
			);
			if (current.status === 'ready' || current.status === 'valid') {
				return { done: current };
			}
			if (current.status === 'invalid') throw orderFailed(where, current);
			return { after, state: `"${current.status}"` };
		});
	}

	/**
	 * Finalizes a `ready` order with a CSR (RFC 8555 §7.4): `createCsr`'s
	 * result, or its DER. Returns the order as the CA answers, `processing`
	 * or `valid`; `waitForOrder` then waits for `valid`.
	 */
	async finalize(
		order: AcmeOrder,
		csr: Csr | Uint8Array,
		options: AcmeRequestOptions = {},
	): Promise<AcmeOrder> {
		const where = 'finalize()';
		const signal = signalOf(options, where);
		if (!isOptions(order)) {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: order must be an order from newOrder() or waitForOrder()`,
			);
		}
		const url = callerUrl(
			order.url,
			'order.url',
			where,
			this.#transport.allowInsecure,
		);
		const finalizeUrl = callerUrl(
			order.finalize,
			'order.finalize',
			where,
			this.#transport.allowInsecure,
		);
		const der =
			csr instanceof Uint8Array
				? csr
				: isOptions(csr)
					? (csr as Csr).der
					: undefined;
		if (!(der instanceof Uint8Array) || der.length === 0) {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: csr must be a Csr from createCsr() or its DER bytes`,
			);
		}
		const kid = this.#account(where);
		const answer = await this.#transport.post(
			where,
			finalizeUrl,
			{ csr: base64url(der) },
			{ signal, kid },
		);
		const updated = orderOf(
			jsonOf(answer, where, 'order'),
			url,
			where,
			this.#transport.allowInsecure,
		);
		if (updated.status === 'invalid') throw orderFailed(where, updated);
		return updated;
	}

	/**
	 * Downloads a certificate chain (RFC 8555 §7.4.2) by a POST-as-GET:
	 * PEM, `application/pem-certificate-chain`, the leaf first, as Bun's TLS
	 * takes it as `cert`. 1 MiB at most.
	 */
	async certificate(
		url: string,
		options: AcmeRequestOptions = {},
	): Promise<string> {
		const where = 'certificate()';
		const signal = signalOf(options, where);
		const target = this.#url(url, where);
		const kid = this.#account(where);
		const answer = await this.#transport.post(where, target, undefined, {
			signal,
			kid,
			accept: 'application/pem-certificate-chain',
			maxBytes: MAX_CERTIFICATE_BYTES,
		});
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(answer.body);
		} catch {
			text = '';
		}
		const chain = text.replace(/\r\n/g, '\n').trim();
		if (!PEM_CHAIN.test(chain)) {
			throw new AcmeError(
				'BAD_RESPONSE',
				`${where}: the CA's answer is not a PEM certificate chain`,
				{ status: answer.status },
			);
		}
		return `${chain}\n`;
	}

	/**
	 * The key authorization of a challenge token for the account key (RFC
	 * 8555 §8.1): what an HTTP-01 responder serves.
	 */
	async keyAuthorization(token: string): Promise<string> {
		return await keyAuthorization(token, this.#transport.publicKey);
	}

	/** The account key's JWK thumbprint (RFC 7638): public, as every key authorization shows it. */
	async accountThumbprint(): Promise<string> {
		return await jwkThumbprint(this.#transport.publicKey);
	}

	/** Bun's and Node's `inspect` show no field, the key's or another. */
	[Symbol.for('nodejs.util.inspect.custom')](): string {
		return 'AcmeClient {}';
	}

	#account(where: string): string {
		if (this.#kid === undefined) {
			throw new AcmeError(
				'NO_ACCOUNT',
				`${where}: no account yet; call newAccount() first, or give the client its kid`,
			);
		}
		return this.#kid;
	}

	#url(url: unknown, where: string): string {
		return callerUrl(url, 'url', where, this.#transport.allowInsecure);
	}

	async #getOrder(
		where: string,
		url: string,
		signal: AbortSignal | undefined,
	): Promise<{ order: AcmeOrder; after: number | undefined }> {
		const target = this.#url(url, where);
		const kid = this.#account(where);
		const answer = await this.#transport.post(where, target, undefined, {
			signal,
			kid,
		});
		return {
			order: orderOf(
				jsonOf(answer, where, 'order'),
				target,
				where,
				this.#transport.allowInsecure,
			),
			after: retryAfter(answer.headers),
		};
	}

	async #getAuthorization(
		where: string,
		url: string,
		signal: AbortSignal | undefined,
	): Promise<{ authorization: AcmeAuthorization; after: number | undefined }> {
		const target = this.#url(url, where);
		const kid = this.#account(where);
		const answer = await this.#transport.post(where, target, undefined, {
			signal,
			kid,
		});
		return {
			authorization: authorizationOf(
				jsonOf(answer, where, 'authorization'),
				target,
				where,
				this.#transport.allowInsecure,
			),
			after: retryAfter(answer.headers),
		};
	}

	/**
	 * Runs `step` until it returns `done`, sleeping between two runs as the
	 * CA's `Retry-After` says, clamped from `pollIntervalMs` to a minute,
	 * all within `timeoutMs`.
	 */
	async #poll<T>(
		where: string,
		options: AcmeWaitOptions,
		step: (signal: AbortSignal) => Promise<PollStep<T>>,
	): Promise<T> {
		const caller = signalOf(options, where);
		const timeoutMs = integerOption(
			options.timeoutMs,
			'timeoutMs',
			where,
			1,
			MAX_WAIT_MS,
			DEFAULT_WAIT_TIMEOUT_MS,
		);
		const deadline = AbortSignal.timeout(timeoutMs);
		const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
		let state = 'unknown';
		const timedOut = (cause: unknown) =>
			new AcmeError(
				'TIMEOUT',
				`${where}: still ${state} after ${timeoutMs} ms`,
				{
					cause,
				},
			);
		for (;;) {
			let result: PollStep<T>;
			try {
				result = await step(signal);
			} catch (error) {
				if (deadline.aborted && !caller?.aborted) throw timedOut(error);
				throw error;
			}
			if ('done' in result) return result.done;
			state = result.state;
			const delay =
				result.after === undefined
					? this.#pollIntervalMs
					: Math.min(
							Math.max(result.after * 1000, this.#pollIntervalMs),
							MAX_POLL_DELAY_MS,
						);
			try {
				await sleep(delay, signal);
			} catch (error) {
				if (caller?.aborted) throw abortedError(where, caller);
				throw timedOut(error);
			}
		}
	}
}

/** The account key pair, both halves checked for their algorithm and type; RSA sizes are checked when signing. */
function accountKeyOf(value: unknown, where: string): CryptoKeyPair {
	const pair = value as Partial<CryptoKeyPair> | undefined;
	if (!isOptions(pair)) {
		throw new AcmeError(
			'INVALID_KEY',
			`${where}: accountKey must be a CryptoKeyPair ({ publicKey, privateKey })`,
		);
	}
	const privateKey = pair?.privateKey;
	const publicKey = pair?.publicKey;
	algorithmOf(privateKey, `${where}: accountKey.privateKey`);
	algorithmOf(publicKey, `${where}: accountKey.publicKey`);
	expectType(
		privateKey as CryptoKey,
		'private',
		`${where}: accountKey.privateKey`,
	);
	expectType(
		publicKey as CryptoKey,
		'public',
		`${where}: accountKey.publicKey`,
	);
	return pair as CryptoKeyPair;
}
