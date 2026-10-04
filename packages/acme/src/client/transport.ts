import { AcmeError } from '../errors';
import { sign } from '../jws/sign';
import { isObject, MAX_JSON_BYTES, parseJson, readBounded } from './body';
import { abortedError, failureOf, untilAborted } from './failure';
import { replayNonce } from './headers';
import { ACME_ERROR, problemError } from './problem';
import { directoryOf } from './resources';
import type { AcmeDirectory, AcmeFetch } from './types';

/** How many times a request is signed again after a `badNonce` (RFC 8555 §6.5), each with the nonce that refusal gave. */
export const MAX_BAD_NONCE_RETRIES = 3;
/** The most nonces kept for later requests. */
const MAX_NONCES = 16;
/** RFC 8555 §6.1: a client sends a User-Agent. */
const USER_AGENT = 'bumail-acme';

/** An answer, its body read and bounded. */
export interface Exchange {
	status: number;
	headers: Headers;
	body: Uint8Array;
}

/** What a transport is made with: checked by `AcmeClient`'s constructor. */
export interface TransportSettings {
	directoryUrl: string;
	accountKey: CryptoKeyPair;
	fetch: AcmeFetch;
	allowInsecure: boolean;
	requestTimeoutMs: number;
}

/** Options of one signed request. */
export interface PostOptions {
	signal: AbortSignal | undefined;
	/** The account URL as `kid`, or undefined to sign with the `jwk` (`newAccount`). */
	kid: string | undefined;
	accept?: string;
	maxBytes?: number;
}

/**
 * The requests of an ACME client: the directory, fetched once and kept;
 * nonces, kept from every answer and fetched with a HEAD when none is
 * left; and the signed POST, signed again on `badNonce`. Every request is
 * bounded in time, never follows a redirect, and reads its answer up to a
 * cap. It holds the account key, in a private field.
 */
export class Transport {
	readonly #settings: TransportSettings;
	readonly #nonces: string[] = [];
	#directory: AcmeDirectory | undefined;
	#pending: Promise<AcmeDirectory> | undefined;

	constructor(settings: TransportSettings) {
		this.#settings = settings;
	}

	get allowInsecure(): boolean {
		return this.#settings.allowInsecure;
	}

	get publicKey(): CryptoKey {
		return this.#settings.accountKey.publicKey;
	}

	/**
	 * The directory, fetched with a GET the first time only: callers that
	 * ask at once share one request, each still stopped by its own signal.
	 */
	async directory(
		where: string,
		signal: AbortSignal | undefined,
	): Promise<AcmeDirectory> {
		if (this.#directory !== undefined) return this.#directory;
		if (signal?.aborted) throw abortedError(where, signal);
		this.#pending ??= this.#fetchDirectory(where).finally(() => {
			this.#pending = undefined;
		});
		if (signal === undefined) return await this.#pending;
		try {
			return await untilAborted(this.#pending, signal);
		} catch (error) {
			if (signal.aborted) throw abortedError(where, signal);
			throw error;
		}
	}

	async #fetchDirectory(where: string): Promise<AcmeDirectory> {
		const answer = await this.send(
			where,
			this.#settings.directoryUrl,
			{ method: 'GET' },
			undefined,
			MAX_JSON_BYTES,
		);
		if (answer.status >= 400) {
			throw problemError(where, answer.status, answer.headers, answer.body);
		}
		this.#directory = directoryOf(
			jsonOf(answer, where, 'directory'),
			where,
			this.allowInsecure,
		);
		return this.#directory;
	}

	/** A fresh nonce from `newNonce`, by a HEAD; not kept. */
	async newNonce(
		where: string,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const { newNonce } = await this.directory(where, signal);
		const answer = await this.send(
			where,
			newNonce,
			{ method: 'HEAD' },
			signal,
			0,
			false,
		);
		if (answer.status >= 400) {
			throw problemError(where, answer.status, answer.headers, answer.body);
		}
		const nonce = replayNonce(answer.headers);
		if (nonce === undefined) {
			throw new AcmeError(
				'BAD_RESPONSE',
				`${where}: the CA's newNonce answer has no valid Replay-Nonce`,
				{ status: answer.status },
			);
		}
		return nonce;
	}

	/**
	 * POSTs a JWS of `payload`, or a POST-as-GET when it is undefined, with
	 * a kept nonce or a fresh one; signed again with the nonce a `badNonce`
	 * refusal gave, `MAX_BAD_NONCE_RETRIES` times at most. An error status
	 * is thrown as `problemError`.
	 */
	async post(
		where: string,
		url: string,
		payload: object | undefined,
		options: PostOptions,
	): Promise<Exchange> {
		const { kid, signal } = options;
		for (let attempt = 0; ; attempt++) {
			const nonce = this.#nonces.pop() ?? (await this.newNonce(where, signal));
			const body = await sign(
				{
					keyPair: this.#settings.accountKey,
					nonce,
					url,
					...(kid === undefined ? {} : { kid }),
					...(payload === undefined ? {} : { payload }),
				},
				this.allowInsecure,
			);
			const headers: Record<string, string> = {
				'content-type': 'application/jose+json',
			};
			if (options.accept !== undefined) headers['accept'] = options.accept;
			const answer = await this.send(
				where,
				url,
				{ method: 'POST', headers, body: JSON.stringify(body) },
				signal,
				options.maxBytes ?? MAX_JSON_BYTES,
			);
			if (answer.status < 400) return answer;
			const error = problemError(
				where,
				answer.status,
				answer.headers,
				answer.body,
			);
			if (
				error.problem?.type !== `${ACME_ERROR}badNonce` ||
				attempt >= MAX_BAD_NONCE_RETRIES
			) {
				throw error;
			}
		}
	}

	/**
	 * One request, within `requestTimeoutMs` and the caller's signal, never
	 * following a redirect, its body read up to `maxBytes` (an error's up to
	 * `MAX_JSON_BYTES`). The answer's `Replay-Nonce` is kept for the next
	 * signed request, unless `keep` is false.
	 */
	async send(
		where: string,
		url: string,
		init: { method: string; headers?: Record<string, string>; body?: string },
		caller: AbortSignal | undefined,
		maxBytes: number,
		keep = true,
	): Promise<Exchange> {
		if (caller?.aborted) throw abortedError(where, caller);
		const ms = this.#settings.requestTimeoutMs;
		const limit = { signal: AbortSignal.timeout(ms), ms };
		const signal = caller
			? AbortSignal.any([caller, limit.signal])
			: limit.signal;
		try {
			const response = await this.#settings.fetch(url, {
				...init,
				headers: { 'user-agent': USER_AGENT, ...init.headers },
				redirect: 'manual',
				signal,
			});
			const nonce = replayNonce(response.headers);
			if (keep && nonce !== undefined) {
				this.#nonces.push(nonce);
				if (this.#nonces.length > MAX_NONCES) this.#nonces.shift();
			}
			const { status, headers } = response;
			if (status >= 300 && status < 400) {
				await response.body?.cancel().catch(() => {});
				throw new AcmeError(
					'BAD_RESPONSE',
					`${where}: the CA answered a redirect (${status}), which an ACME client does not follow`,
					{ status },
				);
			}
			const body =
				init.method === 'HEAD'
					? new Uint8Array(0)
					: await readBounded(
							response,
							status >= 400 ? MAX_JSON_BYTES : maxBytes,
							where,
						);
			return { status, headers, body };
		} catch (error) {
			throw failureOf(where, error, caller, limit);
		}
	}
}

/** The JSON object of an answer, or `BAD_RESPONSE`. */
export function jsonOf(answer: Exchange, where: string, what: string): unknown {
	const value = parseJson(answer.body);
	if (!isObject(value)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's ${what} is not a JSON object`,
			{ status: answer.status },
		);
	}
	return value;
}
