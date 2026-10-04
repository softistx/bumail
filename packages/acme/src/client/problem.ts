import { isArray, shown } from '../encoding';
import { AcmeError } from '../errors';
import { isObject, parseJson } from './body';
import { retryAfter } from './headers';
import type {
	AcmeAuthorization,
	AcmeIdentifier,
	AcmeOrder,
	AcmeProblem,
} from './types';

/** The prefix of every ACME problem type (RFC 8555 §6.7). */
export const ACME_ERROR = 'urn:ietf:params:acme:error:';
/** The longest `detail` kept from a problem document. */
const MAX_DETAIL = 1024;
/** The most subproblems kept from one problem document. */
const MAX_SUBPROBLEMS = 100;

/** Text from the CA, as a message shows it: one line, control characters dropped, cut to `max`. */
export function printable(text: string, max = 300): string {
	const line = text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
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

/** `AUTHORIZATION_FAILED` for an authorization that ended other than `valid`, with its failed challenge's problem. */
export function authorizationFailed(
	where: string,
	authorization: AcmeAuthorization,
): AcmeError {
	const problem = authorization.challenges.find(
		(challenge) => challenge.error !== undefined,
	)?.error;
	return new AcmeError(
		'AUTHORIZATION_FAILED',
		`${where}: the authorization for ${shown(authorization.identifier.value)} is "${authorization.status}"${problem ? `: ${describeProblem(problem)}` : ''}`,
		problem === undefined ? {} : { problem },
	);
}

/** `ORDER_FAILED` for an `invalid` order, with its problem. */
export function orderFailed(where: string, order: AcmeOrder): AcmeError {
	return new AcmeError(
		'ORDER_FAILED',
		`${where}: the order is "invalid"${order.error ? `: ${describeProblem(order.error)}` : ''}`,
		order.error === undefined ? {} : { problem: order.error },
	);
}
