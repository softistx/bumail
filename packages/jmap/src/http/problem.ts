import type { FreeReplyFunction } from '@alxia/core';

/** The request-level errors of RFC 8620 §3.6.1. */
export type ProblemType =
	| 'urn:ietf:params:jmap:error:notJSON'
	| 'urn:ietf:params:jmap:error:notRequest'
	| 'urn:ietf:params:jmap:error:unknownCapability'
	| 'urn:ietf:params:jmap:error:limit'
	| 'about:blank';

/** An RFC 7807 problem details body. */
export interface Problem {
	readonly type: ProblemType;
	readonly status: number;
	readonly detail: string;
	/** For `limit`: the name of the limit, as the session announces it. */
	readonly limit?: string;
}

/** A problem details reply, `application/problem+json`. */
export function problem(
	reply: FreeReplyFunction,
	status: number,
	type: ProblemType,
	detail: string,
	extra: { readonly limit?: string; readonly headers?: HeadersInit } = {},
) {
	const body: Problem = {
		type,
		status,
		detail,
		...(extra.limit === undefined ? {} : { limit: extra.limit }),
	};
	const headers = new Headers(extra.headers);
	headers.set('content-type', 'application/problem+json');
	headers.set('cache-control', 'no-store');
	return reply(status as 400, body, { headers });
}

/** A limit broken: 413 for a size the client sent, 429 for a concurrency, 400 for the rest. */
export function limitProblem(
	reply: FreeReplyFunction,
	limit: string,
	detail: string,
) {
	const status =
		limit.startsWith('maxSize') && limit !== 'maxSizeResponse'
			? 413
			: limit.startsWith('maxConcurrent')
				? 429
				: 400;
	return problem(reply, status, 'urn:ietf:params:jmap:error:limit', detail, {
		limit,
	});
}
