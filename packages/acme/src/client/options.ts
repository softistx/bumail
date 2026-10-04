import { MAX_NAMES } from '../csr/names';
import { isArray, shown } from '../encoding';
import { AcmeError } from '../errors';
import { type AcmeFetch, isObject, isOptions } from './http';
import type { AcmeIdentifier } from './types';

/** The longest wait between two polls, whatever `Retry-After` says. */
export const MAX_POLL_DELAY_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
/** The longest any wait may be: an hour. */
export const MAX_WAIT_MS = 3_600_000;
const MAX_CONTACTS = 10;

/** Options of `new AcmeClient`. */
export interface AcmeClientOptions {
	/**
	 * The CA's directory: `https://acme-v02.api.letsencrypt.org/directory`,
	 * or Let's Encrypt's staging one while testing. `https:` only, unless
	 * `allowInsecure`.
	 */
	directoryUrl: string;
	/** The account key pair, ECDSA P-256 or RSA: it signs every request and is never sent or shown. */
	accountKey: CryptoKeyPair;
	/** The `fetch` to call, the global one by default: give one that trusts a test CA's root, or goes through a proxy. */
	fetch?: AcmeFetch;
	/** The account URL, when the account exists already: requests then need no `newAccount`. */
	kid?: string;
	/**
	 * Takes `http:` URLs, from the caller and from the CA. Only for a test
	 * CA on plain HTTP: never against a real one. Defaults to false.
	 */
	allowInsecure?: boolean;
	/** The time limit of one request, its answer read, in ms: 1 to 600000, 30000 by default. */
	requestTimeoutMs?: number;
	/**
	 * The wait between two polls when the CA gives no `Retry-After`, and the
	 * shortest one when it does, in ms: 10 to 60000, 1000 by default.
	 */
	pollIntervalMs?: number;
}

/** What every request of the client takes. */
export interface AcmeRequestOptions {
	/** Aborts the request: it rejects with `ABORTED`, or `TIMEOUT` when the signal is `AbortSignal.timeout`'s. */
	signal?: AbortSignal;
}

/** Options of `newAccount` (RFC 8555 §7.3). */
export interface NewAccountOptions extends AcmeRequestOptions {
	/** `mailto:` URLs the CA may write to, at most 10. */
	contact?: string[];
	/** True agrees to the CA's terms, the directory's `meta.termsOfService`; a CA that has terms refuses an account without it. */
	termsOfServiceAgreed?: boolean;
	/** True only finds the account of this key, and fails with `accountDoesNotExist` rather than create one. */
	onlyReturnExisting?: boolean;
}

/** Options of `newOrder` (RFC 8555 §7.4). */
export interface NewOrderOptions extends AcmeRequestOptions {
	/** What the certificate is for, at most 100: `{ type: 'dns', value: 'example.com' }`. */
	identifiers: AcmeIdentifier[];
}

/** Options of `waitForOrder` and `waitForAuthorization`. */
export interface AcmeWaitOptions extends AcmeRequestOptions {
	/** How long to wait in all, in ms: 1 to 3600000, 120000 by default. */
	timeoutMs?: number;
}

/** Refuses options that are not an object. */
export function checkOptions(options: unknown, where: string): void {
	if (!isOptions(options)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: options must be an object`,
		);
	}
}

/** The `signal` of request options, checked. */
export function signalOf(
	options: AcmeRequestOptions,
	where: string,
): AbortSignal | undefined {
	checkOptions(options, where);
	const { signal } = options;
	if (signal !== undefined && !(signal instanceof AbortSignal)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: signal must be an AbortSignal`,
		);
	}
	return signal;
}

/** Request options holding `signal`, or none. */
export function withSignal(
	signal: AbortSignal | undefined,
): AcmeRequestOptions {
	return signal === undefined ? {} : { signal };
}

/** An integer option within `min` and `max`, `fallback` when left out. */
export function integerOption(
	value: unknown,
	name: string,
	where: string,
	min: number,
	max: number,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: ${name} must be an integer from ${min} to ${max}, not ${shown(value)}`,
		);
	}
	return value;
}

/** The payload of `newAccount`, its members checked. */
export function accountPayload(
	options: NewAccountOptions,
	where: string,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (options.contact !== undefined) {
		payload['contact'] = contactOf(options.contact, where);
	}
	for (const flag of ['termsOfServiceAgreed', 'onlyReturnExisting'] as const) {
		const value = options[flag];
		if (value === undefined) continue;
		if (typeof value !== 'boolean') {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: ${flag} must be a boolean`,
			);
		}
		payload[flag] = value;
	}
	return payload;
}

function contactOf(value: unknown, where: string): string[] {
	if (!isArray(value) || (value as unknown[]).length > MAX_CONTACTS) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: contact must be an array of at most ${MAX_CONTACTS} mailto: URLs, not ${shown(value)}`,
		);
	}
	return (value as unknown[]).map((item) => {
		if (
			typeof item !== 'string' ||
			item.length > 256 ||
			!/^mailto:[^\s\p{Cc},]+$/u.test(item)
		) {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: a contact is a mailto: URL with one address, not ${shown(item)}`,
			);
		}
		return item;
	});
}

/** The identifiers of `newOrder`, checked: 1 to 100, each a type and a printable value. */
export function identifiersOf(value: unknown, where: string): AcmeIdentifier[] {
	const items = value as unknown[];
	if (!isArray(value) || items.length === 0 || items.length > MAX_NAMES) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: identifiers must be an array of 1 to ${MAX_NAMES} identifiers, not ${shown(value)}`,
		);
	}
	return items.map((item) => {
		const type = isObject(item) ? item['type'] : undefined;
		const text = isObject(item) ? item['value'] : undefined;
		if (
			typeof type !== 'string' ||
			!/^[a-z0-9-]{1,32}$/.test(type) ||
			typeof text !== 'string' ||
			!/^[\x21-\x7e]{1,253}$/.test(text)
		) {
			throw new AcmeError(
				'INVALID_OPTION',
				`${where}: an identifier is { type: 'dns', value: <a name> }, its value printable ASCII of at most 253 characters, not ${shown(item)}`,
			);
		}
		return { type, value: text };
	});
}
