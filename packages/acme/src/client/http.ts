import { isArray, shown } from '../encoding';
import { AcmeError } from '../errors';
import type { AcmeIdentifier, AcmeProblem } from './types';

/** The largest JSON answer read: a directory, an account, an order of 100 names, an authorization. */
export const MAX_JSON_BYTES = 256 * 1024;
/** The largest certificate chain read: a leaf and a few intermediates are a few KiB. */
export const MAX_CERTIFICATE_BYTES = 1024 * 1024;
/** The longest `Retry-After` kept, in seconds: a week. */
export const MAX_RETRY_AFTER = 7 * 24 * 3600;
/** The longest `detail` kept from a problem document. */
const MAX_DETAIL = 1024;
/** The most subproblems kept from one problem document. */
const MAX_SUBPROBLEMS = 100;
/** The longest nonce kept: Let's Encrypt's are about 30 characters. */
const MAX_NONCE_LENGTH = 512;
/** The longest URL kept from the CA. */
const MAX_URL_LENGTH = 2048;

/** The prefix of every ACME problem type (RFC 8555 §6.7). */
export const ACME_ERROR = 'urn:ietf:params:acme:error:';

/** What `fetch` the client calls: the global one, or one given for a test CA or a proxy. */
export type AcmeFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Whether `value` is a URL the client sends a request to: `https:` (or
 * `http:` with `allowInsecure`), without white space, credentials or a
 * fragment, as `signJws` takes it.
 */
export function isRequestUrl(value: unknown, allowInsecure: boolean): boolean {
	if (
		typeof value !== 'string' ||
		value.length > MAX_URL_LENGTH ||
		/[\s\p{Cc}#]/u.test(value)
	) {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return (
		(parsed.protocol === 'https:' ||
			(allowInsecure && parsed.protocol === 'http:')) &&
		parsed.username === '' &&
		parsed.password === ''
	);
}

/** A URL the CA gave, checked, or `BAD_RESPONSE` naming the member it came from. */
export function serverUrl(
	value: unknown,
	member: string,
	where: string,
	allowInsecure: boolean,
): string {
	if (!isRequestUrl(value, allowInsecure)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's ${member} must be an https: URL without credentials or a fragment, not ${shown(value)}`,
		);
	}
	return value as string;
}

/** A URL the caller gave, checked, or `INVALID_OPTION`. */
export function callerUrl(
	value: unknown,
	name: string,
	where: string,
	allowInsecure: boolean,
): string {
	if (!isRequestUrl(value, allowInsecure)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: ${name} must be an https: URL without credentials or a fragment (http: only with allowInsecure), not ${shown(value)}`,
		);
	}
	return value as string;
}

/** The `Replay-Nonce` of an answer, when it is one a JWS can carry. */
export function replayNonce(headers: Headers): string | undefined {
	const nonce = headers.get('replay-nonce');
	return nonce !== null &&
		nonce.length <= MAX_NONCE_LENGTH &&
		/^[A-Za-z0-9_-]+$/.test(nonce)
		? nonce
		: undefined;
}

/**
 * `Retry-After` (RFC 9110 §10.2.3) in seconds, from delay-seconds or an
 * HTTP date, clamped to 0 to a week; undefined when absent or unreadable.
 */
export function retryAfter(
	headers: Headers,
	now: number = Date.now(),
): number | undefined {
	const value = headers.get('retry-after')?.trim();
	if (!value) return undefined;
	let seconds: number;
	if (/^\d+$/.test(value)) {
		seconds = Number(value);
	} else {
		const at = Date.parse(value);
		if (Number.isNaN(at)) return undefined;
		seconds = Math.ceil((at - now) / 1000);
	}
	return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER);
}

/** Text from the CA, as a message shows it: one line, control characters dropped, cut to `max`. */
export function printable(text: string, max = 300): string {
	const line = text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * The bytes of an answer's body, at most `max`: refused before reading by
 * its `Content-Length`, and while reading once past `max`, the rest
 * cancelled unread.
 */
export async function readBounded(
	response: Response,
	max: number,
	where: string,
): Promise<Uint8Array> {
	const tooLarge = () =>
		new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's answer is over ${max} bytes`,
			{ status: response.status },
		);
	const length = Number(response.headers.get('content-length'));
	if (Number.isFinite(length) && length > max) {
		await response.body?.cancel().catch(() => {});
		throw tooLarge();
	}
	const body = response.body;
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** JSON from bytes, or undefined when they are not JSON. */
export function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

/** Whether a value is a plain JSON object. */
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !isArray(value);
}

/** `isObject` without narrowing: for typed options, whose members stay typed. */
export function isOptions(value: unknown): boolean {
	return isObject(value);
}

/** An identifier from the CA, or undefined when it is not one. */
export function identifierOf(value: unknown): AcmeIdentifier | undefined {
	if (
		!isObject(value) ||
		typeof value['type'] !== 'string' ||
		typeof value['value'] !== 'string'
	) {
		return undefined;
	}
	return { type: value['type'], value: value['value'] };
}

/**
 * A problem document from the CA (RFC 7807, RFC 8555 §6.7), its members
 * checked and bounded; undefined when `value` has no string `type`.
 */
export function problemOf(value: unknown, depth = 0): AcmeProblem | undefined {
	if (!isObject(value) || typeof value['type'] !== 'string') return undefined;
	const problem: AcmeProblem = { type: printable(value['type'], 256) };
	if (typeof value['detail'] === 'string') {
		problem.detail = printable(value['detail'], MAX_DETAIL);
	}
	const status = value['status'];
	if (
		typeof status === 'number' &&
		Number.isInteger(status) &&
		status >= 100 &&
		status <= 599
	) {
		problem.status = status;
	}
	const identifier = identifierOf(value['identifier']);
	if (identifier !== undefined) {
		problem.identifier = {
			type: printable(identifier.type, 64),
			value: printable(identifier.value, 256),
		};
	}
	const sub = value['subproblems'];
	if (depth === 0 && isArray(sub)) {
		const subproblems = (sub as unknown[])
			.slice(0, MAX_SUBPROBLEMS)
			.map((item) => problemOf(item, 1))
			.filter((item): item is AcmeProblem => item !== undefined);
		if (subproblems.length > 0) problem.subproblems = subproblems;
	}
	return problem;
}

/** A problem as a message shows it: its type, then its detail, then each subproblem's. */
export function describeProblem(problem: AcmeProblem): string {
	const parts = [problem.type];
	if (problem.detail) parts.push(printable(problem.detail));
	const more = (problem.subproblems ?? [])
		.slice(0, 3)
		.map(
			(sub) =>
				`${sub.identifier ? `${sub.identifier.value}: ` : ''}${printable(sub.detail ?? sub.type, 120)}`,
		);
	const rest = (problem.subproblems?.length ?? 0) - more.length;
	const tail =
		more.length === 0
			? ''
			: ` (${more.join('; ')}${rest > 0 ? `; ${rest} more` : ''})`;
	return `${parts.join(': ')}${tail}`;
}

/** The `AcmeError` for an answer with an error status (RFC 8555 §6.7). */
export function problemError(
	where: string,
	status: number,
	headers: Headers,
	body: Uint8Array,
): AcmeError {
	const problem = problemOf(parseJson(body));
	const after = retryAfter(headers);
	const options = {
		status,
		...(problem === undefined ? {} : { problem }),
		...(after === undefined ? {} : { retryAfter: after }),
	};
	if (problem === undefined) {
		return new AcmeError(
			'SERVER_PROBLEM',
			`${where}: the CA answered ${status} without a problem document`,
			options,
		);
	}
	if (problem.type === `${ACME_ERROR}rateLimited`) {
		return new AcmeError(
			'RATE_LIMITED',
			`${where}: the CA's rate limit: ${describeProblem(problem)}${after === undefined ? '' : ` (retry after ${after} s)`}`,
			options,
		);
	}
	return new AcmeError(
		'SERVER_PROBLEM',
		`${where}: the CA answered ${status}: ${describeProblem(problem)}`,
		options,
	);
}

/**
 * The `AcmeError` for a request that ended without an answer: the
 * caller's signal first (`abortedError`), then the request's own time
 * limit (`TIMEOUT`), else `NETWORK_ERROR`.
 */
export function failureOf(
	where: string,
	error: unknown,
	caller: AbortSignal | undefined,
	limit: { signal: AbortSignal; ms: number } | undefined,
): AcmeError {
	if (error instanceof AcmeError) return error;
	if (caller?.aborted) return abortedError(where, caller);
	if (limit?.signal.aborted) {
		return new AcmeError(
			'TIMEOUT',
			`${where}: no answer within ${limit.ms} ms`,
			{ cause: error },
		);
	}
	return new AcmeError(
		'NETWORK_ERROR',
		`${where}: fetch failed: ${printable(error instanceof Error ? error.message : String(error), 200)}`,
		{ cause: error },
	);
}

/**
 * The `AcmeError` for the caller's signal having fired: `TIMEOUT` when its
 * reason is a timeout (`AbortSignal.timeout`), `ABORTED` otherwise, the
 * reason kept as the cause.
 */
export function abortedError(where: string, signal: AbortSignal): AcmeError {
	const reason: unknown = signal.reason;
	if (reason instanceof DOMException && reason.name === 'TimeoutError') {
		return new AcmeError('TIMEOUT', `${where}: the signal timed out`, {
			cause: reason,
		});
	}
	return new AcmeError('ABORTED', `${where}: aborted`, { cause: reason });
}

/** Waits `ms`, or rejects with `signal`'s reason as soon as it fires. */
export function sleep(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const done = () => {
			signal?.removeEventListener('abort', aborted);
			resolve();
		};
		const timer = setTimeout(done, ms);
		const aborted = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener('abort', aborted, { once: true });
	});
}
