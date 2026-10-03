import { type FreeReplyFunction, parseRange } from '@alxia/core';
import { resolveBlob } from '../blob/resolve';
import type { Runtime } from '../server/runtime';
import { isId } from '../shared/text';
import type { Authenticated } from './auth';
import { problem } from './problem';

/** A media type a client may ask a download to be served as, without parameters. */
const MEDIA_TYPE =
	/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** `Content-Disposition` for a file name (RFC 6266, RFC 8187). */
function disposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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
	const notFound = () =>
		problem(reply, 404, 'about:blank', 'No blob has this id');
	if (params.accountId !== auth.accountId || !isId(params.blobId))
		return notFound();
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
		'content-disposition': disposition(params.name.slice(0, 255)),
		'cache-control': 'private, immutable, max-age=31536000',
		'accept-ranges': 'bytes',
	});
	const range = request.headers.get('range');
	const parsed = range === null ? undefined : parseRange(range, blob.size);
	if (parsed === 'unsatisfiable') {
		headers.set('content-range', `bytes */${blob.size}`);
		return reply(416, '', { headers });
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
