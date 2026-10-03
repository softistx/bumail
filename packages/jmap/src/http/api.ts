import type { AnyReply, FreeReplyFunction } from '@alxia/core';
import type { CallContext } from '../api/context';
import { dispatch } from '../api/dispatch';
import { METHODS } from '../api/methods';
import { checkRequest, parseJson, type Refused } from '../api/request';
import type { Runtime } from '../server/runtime';
import { sessionOf } from '../server/session';
import type { Authenticated } from './auth';
import { jmapProblem, limitProblem } from './problem';

function refusal(refused: Refused) {
	if (refused.type === 'limit') {
		return limitProblem(refused.limit ?? 'limit', refused.detail);
	}
	return jmapProblem(
		400,
		`urn:ietf:params:jmap:error:${refused.type}`,
		refused.detail,
	);
}

async function answer(
	runtime: Runtime,
	auth: Authenticated,
	request: Request,
	reply: FreeReplyFunction,
): Promise<AnyReply> {
	const { settings } = runtime;
	const { limits } = settings;
	// The route's `bodyLimit` (maxSizeRequest) bounds this read: past it,
	// alxia stops reading and the route's `onRefusal` answers.
	const bytes = new Uint8Array(await request.arrayBuffer());
	const json = parseJson(bytes, limits);
	if (!json.ok) return refusal(json.refused);
	const checked = checkRequest(json.value, limits);
	if (!checked.ok) return refusal(checked.refused);
	const ctx: CallContext = {
		settings,
		store: settings.store,
		accountId: auth.accountId,
		using: new Set(checked.request.using),
		created: new Map(Object.entries(checked.request.createdIds ?? {})),
		uploads: runtime.uploads,
		request,
		bodyBudget: limits.maxBodyValuesTotal,
		references: {
			maxItems: limits.maxReferenceItems,
			maxBytes: limits.maxReferenceBytes,
			left: limits.maxReferenceBytes,
		},
	};
	const answered = await dispatch(
		checked.request,
		ctx,
		METHODS,
		sessionOf(settings, auth).state,
	);
	if (!answered.ok) return refusal(answered.refused);
	return reply(200, answered.response, {
		headers: { 'cache-control': 'no-store' },
	});
}

/** `POST {basePath}/api` (RFC 8620 §3): one request, its calls in order, at most `maxConcurrentRequests` at once. */
export function handleApi(
	runtime: Runtime,
	auth: Authenticated,
	request: Request,
	reply: FreeReplyFunction,
): Promise<AnyReply> {
	return runtime.requests.run(
		auth.accountId,
		() => answer(runtime, auth, request, reply),
		() => {
			request.body?.cancel().catch(() => undefined);
			return limitProblem(
				'maxConcurrentRequests',
				`The account has ${runtime.settings.limits.maxConcurrentRequests} requests in flight already`,
			);
		},
	);
}
