import { alxia, type Refusal, type Reply } from '@alxia/core';
import { handleApi } from '../http/api';
import {
	type Authenticated,
	type Refusal as AuthRefusal,
	authenticate,
	CHALLENGES,
} from '../http/auth';
import { handleDownload } from '../http/download';
import { ACCOUNT_NOT_FOUND, BLOB_NOT_FOUND, idParams } from '../http/params';
import { jmapProblem, limitProblem, type ProblemBody } from '../http/problem';
import { handleUpload } from '../http/upload';
import type { JmapOptions } from './options';
import { runtimeOf } from './runtime';
import { sessionOf } from './session';
import { settingsOf } from './settings';

function refuse(refusal: AuthRefusal) {
	const headers = new Headers();
	if (refusal.status === 401)
		for (const challenge of CHALLENGES)
			headers.append('www-authenticate', challenge);
	if (refusal.status === 503) headers.set('retry-after', '5');
	return jmapProblem(refusal.status, 'about:blank', refusal.detail, {
		headers,
	});
}

/**
 * What a route answers a request alxia refused before its handler, always
 * as a problem: a body past its `bodyLimit` is the JMAP `limit` problem
 * naming the session's `limit`; a path parameter that is not an Id names
 * nothing, so it is the route's `notFound`, a 404; any other part refused
 * is `notRequest`.
 */
function refused(answers: {
	readonly limit: 'maxSizeRequest' | 'maxSizeUpload';
	readonly notFound?: string;
}) {
	const what = answers.limit === 'maxSizeUpload' ? 'upload' : 'request';
	// One `Reply` type, not a union of them: alxia 0.2.0 names a union of
	// refusal replies by a type it does not export, which a declaration
	// file cannot then name (TS2883).
	return (refusal: Refusal): Reply<400 | 404 | 413 | 429, ProblemBody> => {
		if (refusal.kind === 'body_limit')
			return limitProblem(
				answers.limit,
				`The ${what} is larger than ${refusal.limit} bytes`,
			);
		if (refusal.part === 'params' && answers.notFound !== undefined)
			return jmapProblem(404, 'about:blank', answers.notFound);
		return jmapProblem(
			400,
			'urn:ietf:params:jmap:error:notRequest',
			`The request's ${refusal.part} are invalid`,
		);
	};
}

/** What `jmap()` returns besides its routes. */
export interface JmapServer {
	/**
	 * Tells the server an account's mail changed outside it — a delivery, an
	 * IMAP session. Reserved for push (RFC 8620 §7), a later slice: today it
	 * does nothing, so calling it now is safe and keeps working once push lands.
	 */
	notify(accountId: string): void;
}

/**
 * A JMAP server (RFC 8620, RFC 8621) as an alxia app, to `use` in a host
 * app: the session at `/.well-known/jmap`, and under `basePath` the API,
 * download and upload. Every route authenticates its request first; the
 * host's own routes are left alone.
 */
export function jmap(options: JmapOptions) {
	const settings = settingsOf(options);
	const runtime = runtimeOf(settings);
	const base = settings.basePath;
	const { limits } = settings;
	const app = alxia().group((scope) =>
		scope
			.derive(async ({ request }) => {
				const result = await authenticate(settings, request);
				return 'accountId' in result
					? { auth: result as Authenticated }
					: refuse(result);
			})
			.get('/.well-known/jmap', ({ auth, reply }) =>
				reply(200, sessionOf(settings, auth), {
					headers: { 'cache-control': 'no-store' },
				}),
			)
			.onRefusal(refused({ limit: 'maxSizeRequest' }))
			.post(
				`${base}/api` as '/jmap/api',
				{ bodyLimit: limits.maxSizeRequest },
				({ auth, request, reply }) => handleApi(runtime, auth, request, reply),
			)
			.onRefusal(refused({ limit: 'maxSizeRequest', notFound: BLOB_NOT_FOUND }))
			.get(
				`${base}/download/:accountId/:blobId/:name` as '/jmap/download/:accountId/:blobId/:name',
				{ params: idParams(['accountId', 'blobId'], ['name']) },
				({ auth, params, request, reply }) =>
					handleDownload(runtime, auth, params, request, reply),
			)
			.onRefusal(
				refused({ limit: 'maxSizeUpload', notFound: ACCOUNT_NOT_FOUND }),
			)
			.post(
				`${base}/upload/:accountId` as '/jmap/upload/:accountId',
				{
					params: idParams(['accountId']),
					bodyLimit: limits.maxSizeUpload,
				},
				({ auth, params, request, reply }) =>
					handleUpload(runtime, auth, params.accountId, request, reply),
			),
	);
	const server: JmapServer = {
		notify(accountId: string) {
			if (typeof accountId !== 'string')
				throw new TypeError('notify(accountId): accountId is a string');
		},
	};
	return Object.assign(app, server);
}
