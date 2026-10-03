import { type ClientErrorStatus, problem } from '@alxia/core';

/** The request-level errors of RFC 8620 §3.6.1. */
export type ProblemType =
	| 'urn:ietf:params:jmap:error:notJSON'
	| 'urn:ietf:params:jmap:error:notRequest'
	| 'urn:ietf:params:jmap:error:unknownCapability'
	| 'urn:ietf:params:jmap:error:limit'
	| 'about:blank';

/** An RFC 7807 problem details body, as the server sends it. */
export interface ProblemBody {
	readonly type: ProblemType;
	readonly status: number;
	readonly detail: string;
	/** For `limit`: the name of the limit, as the session announces it. */
	readonly limit?: string;
}

/**
 * An RFC 7807 problem details reply, `application/problem+json` through
 * alxia's `problem()`, never cached. `limit` names the limit of a
 * `urn:ietf:params:jmap:error:limit` problem, as the session announces it.
 */
export function jmapProblem<const Status extends ClientErrorStatus | 503>(
	status: Status,
	type: ProblemType,
	detail: string,
	extra: { readonly limit?: string; readonly headers?: HeadersInit } = {},
) {
	const headers = new Headers(extra.headers);
	headers.set('cache-control', 'no-store');
	return problem(
		{
			type,
			status,
			detail,
			...(extra.limit === undefined ? {} : { limit: extra.limit }),
		},
		{ headers },
	);
}

/**
 * A limit broken: 413 for a size the client sent, 429 for a concurrency,
 * 400 for the rest. RFC 8620 §3.6.1 sets no status for `limit` (its example
 * answers 400); 413 and 429 are HTTP's own for a body too large and for too
 * many requests.
 */
export function limitProblem(limit: string, detail: string) {
	const status =
		limit.startsWith('maxSize') && limit !== 'maxSizeResponse'
			? 413
			: limit.startsWith('maxConcurrent')
				? 429
				: 400;
	return jmapProblem(status, 'urn:ietf:params:jmap:error:limit', detail, {
		limit,
	});
}
