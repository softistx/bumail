import type { FreeReplyFunction } from '@alxia/core';
import type { Runtime } from '../server/runtime';
import type { Authenticated } from './auth';
import { readBounded } from './body';
import { limitProblem, problem } from './problem';

const MEDIA_TYPE =
	/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The upload's media type, from its `Content-Type`, parameters left out. */
function typeOf(request: Request): string {
	const type =
		(request.headers.get('content-type') ?? '')
			.split(';')[0]
			?.trim()
			.toLowerCase() ?? '';
	return MEDIA_TYPE.test(type) ? type : 'application/octet-stream';
}

async function store(
	runtime: Runtime,
	auth: Authenticated,
	request: Request,
	reply: FreeReplyFunction,
) {
	const { limits } = runtime.settings;
	const body = await readBounded(request, limits.maxSizeUpload);
	if (!body.ok) {
		return limitProblem(
			reply,
			'maxSizeUpload',
			`The upload is larger than ${limits.maxSizeUpload} bytes`,
		);
	}
	const type = typeOf(request);
	const upload = runtime.uploads.add(auth.accountId, body.bytes, type);
	if (upload === undefined) {
		return problem(
			reply,
			413,
			'urn:ietf:params:jmap:error:limit',
			`The account holds ${limits.uploadQuota} bytes of uploads already: use them or wait for them to expire`,
			{ limit: 'uploadQuota' },
		);
	}
	return reply(
		201,
		{
			accountId: auth.accountId,
			blobId: upload.blobId,
			type,
			size: upload.bytes.length,
		},
		{ headers: { 'cache-control': 'no-store' } },
	);
}

/** `POST {basePath}/upload/{accountId}` (RFC 8620 §6.1): held in memory, at most `maxConcurrentUpload` at once. */
export function handleUpload(
	runtime: Runtime,
	auth: Authenticated,
	accountId: string,
	request: Request,
	reply: FreeReplyFunction,
) {
	if (accountId !== auth.accountId) {
		request.body?.cancel().catch(() => undefined);
		return problem(reply, 404, 'about:blank', 'No account has this id');
	}
	return runtime.uploading.run(
		auth.accountId,
		() => store(runtime, auth, request, reply),
		() => {
			request.body?.cancel().catch(() => undefined);
			return limitProblem(
				reply,
				'maxConcurrentUpload',
				`The account has ${runtime.settings.limits.maxConcurrentUpload} uploads in flight already`,
			);
		},
	);
}
