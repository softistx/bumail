import { alxia, type FreeReplyFunction } from '@alxia/core';
import { handleApi } from '../http/api';
import {
	type Authenticated,
	authenticate,
	CHALLENGES,
	type Refusal,
} from '../http/auth';
import { handleDownload } from '../http/download';
import { problem } from '../http/problem';
import { handleUpload } from '../http/upload';
import type { JmapOptions } from './options';
import { runtimeOf } from './runtime';
import { sessionOf } from './session';
import { settingsOf } from './settings';

function refuse(reply: FreeReplyFunction, refusal: Refusal) {
	const headers = new Headers();
	if (refusal.status === 401)
		for (const challenge of CHALLENGES)
			headers.append('www-authenticate', challenge);
	if (refusal.status === 503) headers.set('retry-after', '5');
	return problem(reply, refusal.status, 'about:blank', refusal.detail, {
		headers,
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
 * A JMAP server (RFC 8620, RFC 8621) as an alxia app, to `use` in a host
 * app: the session at `/.well-known/jmap`, and under `basePath` the API,
 * download and upload. Every route authenticates its request first; the
 * host's own routes are left alone.
 */
export function jmap(options: JmapOptions) {
	const settings = settingsOf(options);
	const runtime = runtimeOf(settings);
	const base = settings.basePath;
	const app = alxia().group((scope) =>
		scope
			.derive(async ({ request, reply }) => {
				const result = await authenticate(settings, request);
				return 'accountId' in result
					? { auth: result as Authenticated }
					: refuse(reply, result);
			})
			.get('/.well-known/jmap', ({ auth, reply }) =>
				reply(200, sessionOf(settings, auth), {
					headers: { 'cache-control': 'no-store' },
				}),
			)
			.post(`${base}/api` as '/jmap/api', ({ auth, request, reply }) =>
				handleApi(runtime, auth, request, reply),
			)
			.get(
				`${base}/download/:accountId/:blobId/:name` as '/jmap/download/:accountId/:blobId/:name',
				({ auth, params, request, reply }) =>
					handleDownload(runtime, auth, params, request, reply),
			)
			.post(
				`${base}/upload/:accountId` as '/jmap/upload/:accountId',
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
