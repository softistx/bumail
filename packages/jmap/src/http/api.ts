import type { FreeReplyFunction } from '@alxia/core';
import type { CallContext } from '../api/context';
import { dispatch } from '../api/dispatch';
import { METHODS } from '../api/methods';
import { checkRequest, parseJson, type Refused } from '../api/request';
import type { Runtime } from '../server/runtime';
import { sessionOf } from '../server/session';
import type { Authenticated } from './auth';
import { readBounded } from './body';
import { limitProblem, problem } from './problem';

function refusal(reply: FreeReplyFunction, refused: Refused) {
	if (refused.type === 'limit') {
		return limitProblem(reply, refused.limit ?? 'limit', refused.detail);
	}
	return problem(
		reply,
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
) {
	const { settings } = runtime;
	const { limits } = settings;
	const body = await readBounded(request, limits.maxSizeRequest);
	if (!body.ok) {
		return limitProblem(
			reply,
			'maxSizeRequest',
			`The request is larger than ${limits.maxSizeRequest} bytes`,
		);
	}
	const json = parseJson(body.bytes, limits);
	if (!json.ok) return refusal(reply, json.refused);
	const checked = checkRequest(json.value, limits);
	if (!checked.ok) return refusal(reply, checked.refused);
	const ctx: CallContext = {
		settings,
		store: settings.store,
		accountId: auth.accountId,
		using: new Set(checked.request.using),
		created: new Map(Object.entries(checked.request.createdIds ?? {})),
		uploads: runtime.uploads,
		request,
		bodyBudget: limits.maxBodyValuesTotal,
	};
	const response = await dispatch(
		checked.request,
		ctx,
		METHODS,
		sessionOf(settings, auth).state,
	);
	return reply(200, response, { headers: { 'cache-control': 'no-store' } });
}

/** `POST {basePath}/api` (RFC 8620 §3): one request, its calls in order, at most `maxConcurrentRequests` at once. */
export function handleApi(
	runtime: Runtime,
	auth: Authenticated,
	request: Request,
	reply: FreeReplyFunction,
) {
	return runtime.requests.run(
		auth.accountId,
		() => answer(runtime, auth, request, reply),
		() => {
			request.body?.cancel().catch(() => undefined);
			return limitProblem(
				reply,
				'maxConcurrentRequests',
				`The account has ${runtime.settings.limits.maxConcurrentRequests} requests in flight already`,
			);
		},
	);
}
