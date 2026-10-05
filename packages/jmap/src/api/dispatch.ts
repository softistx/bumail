import { StoreError } from '@bumail/store';
import type { Args } from './args';
import type { CallContext } from './context';
import { MethodError } from './errors';
import { resolveReferences } from './refs';
import type { Invocation, JmapRequest, Refused } from './request';
import { jsonSize } from './size';

/** A method: its arguments, checked by itself, to its response's arguments. */
export type MethodHandler = (args: Args, ctx: CallContext) => Promise<Args>;

/** A method and the capability `using` must name for it. */
export interface Method {
	readonly capability: string;
	readonly handler: MethodHandler;
}

/** The answer to a whole request (RFC 8620 §3.4). */
export interface JmapResponse {
	readonly methodResponses: Invocation[];
	readonly createdIds?: Record<string, string>;
	readonly sessionState: string;
}

/** What a thrown error becomes: a method error, or `serverFail` reported to `onError`. */
function errorOf(error: unknown, ctx: CallContext, method: string): Args {
	if (error instanceof MethodError) return error.toJSON();
	if (
		error instanceof StoreError &&
		error.code === 'CANNOT_CALCULATE_CHANGES'
	) {
		return { type: 'cannotCalculateChanges' };
	}
	ctx.settings.options.onError?.(error, {
		request: ctx.request,
		client: ctx.client,
		accountId: ctx.accountId,
		method,
	});
	return { type: 'serverFail' };
}

async function call(
	[name, given, callId]: Invocation,
	responses: Invocation[],
	ctx: CallContext,
	methods: ReadonlyMap<string, Method>,
): Promise<Invocation> {
	const method = methods.get(name);
	if (method === undefined || !ctx.using.has(method.capability)) {
		return ['error', { type: 'unknownMethod' }, callId];
	}
	try {
		const args = resolveReferences(given, responses, ctx.references);
		return [name, await method.handler(args, ctx), callId];
	} catch (error) {
		return ['error', errorOf(error, ctx, name), callId];
	}
}

/**
 * Runs each method call in order, each seeing the responses before it
 * (RFC 8620 §3.3). A response growing past `maxSizeResponse` stops the
 * request: it is refused as a whole, as a `limit` (RFC 8620 §3.6.1).
 */
export async function dispatch(
	request: JmapRequest,
	ctx: CallContext,
	methods: ReadonlyMap<string, Method>,
	sessionState: string,
): Promise<
	{ ok: true; response: JmapResponse } | { ok: false; refused: Refused }
> {
	const max = ctx.settings.limits.maxSizeResponse;
	let left = max;
	const responses: Invocation[] = [];
	for (const invocation of request.methodCalls) {
		const response = await call(invocation, responses, ctx, methods);
		left -= jsonSize(response, left);
		if (left < 0) {
			return {
				ok: false,
				refused: {
					type: 'limit',
					limit: 'maxSizeResponse',
					detail: `The response would be larger than ${max} bytes`,
				},
			};
		}
		responses.push(response);
	}
	const response: JmapResponse = {
		methodResponses: responses,
		...(request.createdIds === undefined
			? {}
			: { createdIds: Object.fromEntries(ctx.created) }),
		sessionState,
	};
	return { ok: true, response };
}
