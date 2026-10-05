import {
	alxia,
	defineMiddleware,
	originalUrl,
	refusalOf,
	validate,
} from '@alxia/core';
import { handleApi } from '../http/api';
import {
	type Authenticated,
	type Refusal as AuthRefusal,
	authenticate,
	CHALLENGES,
} from '../http/auth';
import { handleDownload } from '../http/download';
import { ACCOUNT_NOT_FOUND, BLOB_NOT_FOUND, idParams } from '../http/params';
import { jmapProblem, limitProblem } from '../http/problem';
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
 * The middleware that answers a request alxia refused on a route, always
 * as a problem: a body past its `bodyLimit` is the JMAP `limit` problem
 * naming the session's `limit`, which only a route with a `bodyLimit`
 * names; a path parameter that is not an Id names nothing, so it is the
 * route's `notFound`, a 404; any other part refused is `notRequest`. A
 * refusal before the body is read cancels it, so an upload refused for its
 * path is not left unread. Given before the route's `validate`, it catches
 * what `next()` rejects with; any other error, a client that hung up
 * included, goes on to alxia's route boundary.
 */
function refused(answers: {
	readonly limit?: 'maxSizeRequest' | 'maxSizeUpload';
	readonly notFound?: string;
}) {
	const what = answers.limit === 'maxSizeUpload' ? 'upload' : 'request';
	return defineMiddleware(async ({ request }, next) => {
		try {
			return await next();
		} catch (error) {
			const refusal = refusalOf(error);
			if (refusal === undefined) throw error;
			if (refusal.kind === 'body_limit' && answers.limit !== undefined)
				return limitProblem(
					answers.limit,
					`The ${what} is larger than ${refusal.limit} bytes`,
				);
			// A body alxia did not read, or stopped reading: cancelled, and a body
			// already read refuses the cancel, which is ignored.
			request.body?.cancel().catch(() => undefined);
			const part = refusal.kind === 'validation' ? refusal.part : 'body';
			if (part === 'params' && answers.notFound !== undefined)
				return jmapProblem(404, 'about:blank', answers.notFound);
			// No route reaches this yet: each validates only its path parameters,
			// a 404, sets a `bodyLimit` only with its `limit`, and the API reads
			// its own body. It stays as the guard for a route that validates more.
			return jmapProblem(
				400,
				'urn:ietf:params:jmap:error:notRequest',
				`The request's ${part} are invalid`,
			);
		}
	});
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
 * A JMAP server (RFC 8620, RFC 8621) as an alxia app, to `plugin` in a host
 * app: the session at `/.well-known/jmap`, and under `basePath` the API,
 * download and upload. Every route authenticates its request first; the
 * host's own routes are left alone. The host's `ip` and `proxy` options
 * say who a request is from: `authenticate`, `secure` and `onError` are
 * told its `ctx.ip` and `originalUrl(ctx)`.
 */
export function jmap(options: JmapOptions) {
	const settings = settingsOf(options);
	const runtime = runtimeOf(settings);
	const base = settings.basePath;
	const { limits } = settings;
	const app = alxia().group((scope) =>
		scope
			.derive(async (ctx) => {
				const client = { ip: ctx.ip, url: originalUrl(ctx) };
				const result = await authenticate(settings, ctx.request, client);
				return 'accountId' in result
					? { auth: result as Authenticated, client }
					: refuse(result);
			})
			.get('/.well-known/jmap', ({ auth, reply }) =>
				reply(200, sessionOf(settings, auth), {
					headers: { 'cache-control': 'no-store' },
				}),
			)
			.post(
				`${base}/api` as '/jmap/api',
				{ bodyLimit: limits.maxSizeRequest },
				refused({ limit: 'maxSizeRequest' }),
				({ auth, client, request, reply }) =>
					handleApi(runtime, auth, client, request, reply),
			)
			.get(
				`${base}/download/:accountId/:blobId/:name` as '/jmap/download/:accountId/:blobId/:name',
				refused({ notFound: BLOB_NOT_FOUND }),
				validate({ params: idParams(['accountId', 'blobId'], ['name']) }),
				({ auth, params, request, reply }) =>
					handleDownload(runtime, auth, params, request, reply),
			)
			.post(
				`${base}/upload/:accountId` as '/jmap/upload/:accountId',
				{ bodyLimit: limits.maxSizeUpload },
				refused({ limit: 'maxSizeUpload', notFound: ACCOUNT_NOT_FOUND }),
				validate({ params: idParams(['accountId']) }),
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
