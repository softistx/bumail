import type { MailStore } from '@bumail/store';
import { parseEmail, partIdOf, walk } from '../email/parse';
import type { Uploads } from './uploads';

/** A blob found for a download: its bytes and, for an upload, the type it came with. */
export interface Found {
	readonly blob: Blob;
	readonly type?: string;
}

/** A part's blob id: the email's blob id, `_`, the part id with `-` for `.`. */
const PART = /^([0-9a-f]{64})_([0-9]+(?:-[0-9]+)*)$/;

async function partOf(
	store: MailStore,
	accountId: string,
	blobId: string,
	partId: string,
): Promise<Found | undefined> {
	const blob = await store.readContent(accountId, blobId);
	if (blob === undefined) return undefined;
	const path = partId === '1' ? undefined : partId;
	const root = await parseEmail(blob, {
		part: path ?? '1',
		keepPart: blob.size,
	});
	for (const part of walk(root)) {
		if (part.contentType.type === 'multipart' || partIdOf(part) !== partId)
			continue;
		const type = part.contentType.mediaType.toLowerCase();
		return { blob: new Blob(part.kept as BlobPart[], { type }), type };
	}
	return undefined;
}

/**
 * The account's blob with this id: an upload, a stored email, or one part
 * of a stored email. Another account's blob is never found.
 */
export async function resolveBlob(
	store: MailStore,
	uploads: Uploads,
	accountId: string,
	blobId: string,
): Promise<Found | undefined> {
	const upload = uploads.get(accountId, blobId);
	if (upload !== undefined) {
		return {
			blob: new Blob([upload.bytes as BlobPart], { type: upload.type }),
			type: upload.type,
		};
	}
	const part = PART.exec(blobId);
	if (part !== null) {
		const [, emailBlob = '', partId = ''] = part;
		return partOf(store, accountId, emailBlob, partId.replaceAll('-', '.'));
	}
	const blob = await store.readContent(accountId, blobId);
	return blob === undefined ? undefined : { blob };
}
