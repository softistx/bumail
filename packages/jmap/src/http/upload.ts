import type { AnyReply, FreeReplyFunction } from '@alxia/core';
import type { Runtime } from '../server/runtime';
import type { Authenticated } from './auth';
import { ACCOUNT_NOT_FOUND } from './params';
import { jmapProblem, limitProblem } from './problem';

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
): Promise<AnyReply> {
	const { limits } = runtime.settings;
	// The route's `bodyLimit` (maxSizeUpload) bounds this read: past it,
	// alxia stops reading and the route's `onRefusal` answers.
	const bytes = new Uint8Array(await request.arrayBuffer());
	const type = typeOf(request);
	const upload = runtime.uploads.add(auth.accountId, bytes, type);
	if (upload === undefined) {
		return jmapProblem(
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
): AnyReply | Promise<AnyReply> {
	if (accountId !== auth.accountId) {
		request.body?.cancel().catch(() => undefined);
		return jmapProblem(404, 'about:blank', ACCOUNT_NOT_FOUND);
	}
	return runtime.uploading.run(
		auth.accountId,
		() => store(runtime, auth, request, reply),
		() => {
			request.body?.cancel().catch(() => undefined);
			return limitProblem(
				'maxConcurrentUpload',
				`The account has ${runtime.settings.limits.maxConcurrentUpload} uploads in flight already`,
			);
		},
	);
}
