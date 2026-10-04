import { type FreeReplyFunction, parseRange } from '@alxia/core';
import { resolveBlob } from '../blob/resolve';
import type { Runtime } from '../server/runtime';
import type { Authenticated } from './auth';
import { BLOB_NOT_FOUND } from './params';
import { jmapProblem } from './problem';

/** A media type a client may ask a download to be served as, without parameters. */
const MEDIA_TYPE =
	/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** The longest file name kept, in code points. */
const MAX_NAME = 255;

/**
 * Types a browser shows without running anything: served `inline`. Every
 * other type, HTML, SVG and XML first, is an `attachment`, so a download
 * URL never renders active content in the server's origin.
 */
const SAFE_INLINE = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'text/plain',
]);

/** The name cut to `MAX_NAME` code points, never inside a surrogate pair, lone surrogates replaced. */
export function nameOf(name: string): string {
	return [...name.toWellFormed()].slice(0, MAX_NAME).join('');
}

/** `Content-Disposition` for a type and a file name (RFC 6266, RFC 8187). */
export function disposition(type: string, name: string): string {
	const kind = SAFE_INLINE.has(type) ? 'inline' : 'attachment';
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export interface DownloadParams {
	readonly accountId: string;
	readonly blobId: string;
	readonly name: string;
}

/** `GET {basePath}/download/{accountId}/{blobId}/{name}?accept={type}` (RFC 8620 §6.2), with one `Range`. */
export async function handleDownload(
	runtime: Runtime,
	auth: Authenticated,
	params: DownloadParams,
	request: Request,
	reply: FreeReplyFunction,
) {
	const notFound = () => jmapProblem(404, 'about:blank', BLOB_NOT_FOUND);
	if (params.accountId !== auth.accountId) return notFound();
	const found = await resolveBlob(
		runtime.settings.store,
		runtime.uploads,
		auth.accountId,
		params.blobId,
	);
	if (found === undefined) return notFound();
	const accept = new URL(request.url).searchParams.get('accept') ?? '';
	const type = MEDIA_TYPE.test(accept)
		? accept.toLowerCase()
		: (found.type ?? 'application/octet-stream');
	const { blob } = found;
	const headers = new Headers({
		'content-type': type,
		'content-disposition': disposition(type, nameOf(params.name)),
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; sandbox",
		'cache-control': 'private, immutable, max-age=31536000',
		'accept-ranges': 'bytes',
	});
	const range = request.headers.get('range');
	const asked = range === null ? undefined : parseRange(range, blob.size);
	// A suffix range of an empty blob has no bytes to send: RFC 9110 §14.1.1
	// ignores it, and the empty blob is served whole. alxia's parseRange
	// answers it as `bytes 0--1/0` until its next patch.
	const parsed =
		blob.size === 0 && typeof asked === 'object' ? undefined : asked;
	if (parsed === 'unsatisfiable') {
		// An error, not the blob: never cached, with none of the blob's
		// headers, and no body, so no Content-Type.
		return reply(416, undefined, {
			headers: {
				'content-range': `bytes */${blob.size}`,
				'accept-ranges': 'bytes',
				'cache-control': 'no-store',
			},
		});
	}
	if (parsed !== undefined) {
		headers.set(
			'content-range',
			`bytes ${parsed.start}-${parsed.end}/${blob.size}`,
		);
		return reply(206, blob.slice(parsed.start, parsed.end + 1, type), {
			headers,
		});
	}
	return reply(200, blob.slice(0, blob.size, type), { headers });
}
