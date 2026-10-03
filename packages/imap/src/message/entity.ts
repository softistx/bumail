import {
	type ContentType,
	MessageHeaders,
	parseContentType,
} from '@bumail/mime';

/** A MIME entity of a message (RFC 2045): where its header and body lie, and what they say. */
export interface Entity {
	/** Where its header starts. */
	readonly start: number;
	/** Where its body starts: after the blank line ending the header. */
	bodyStart: number;
	/** Where its body ends: before the line break of the next delimiter, or the end. */
	end: number;
	headers: MessageHeaders;
	contentType: ContentType;
	/** Lines in the body, as BODYSTRUCTURE counts them. */
	lines: number;
	/** The parts of a multipart. */
	readonly children: Entity[];
	/** The message a message/rfc822 part holds. */
	message?: Entity;
}

/** A new entity whose header starts at `start`. */
export function newEntity(start: number): Entity {
	return {
		start,
		bodyStart: start,
		end: start,
		headers: new MessageHeaders(),
		contentType: parseContentType(undefined),
		lines: 0,
		children: [],
	};
}

function isBlank(bytes: Uint8Array): boolean {
	for (const byte of bytes) if (byte !== 0x20 && byte !== 0x09) return false;
	return true;
}

/** Whether a line (after its `--`) opens or closes the multipart of this boundary. */
export function delimiter(
	after: Uint8Array,
	boundary: Uint8Array,
): 'open' | 'close' | undefined {
	if (after.length < boundary.length) return undefined;
	for (let i = 0; i < boundary.length; i++)
		if (after[i] !== boundary[i]) return undefined;
	const rest = after.subarray(boundary.length);
	if (rest[0] === 0x2d && rest[1] === 0x2d && isBlank(rest.subarray(2)))
		return 'close';
	return isBlank(rest) ? 'open' : undefined;
}

/** A message/rfc822 (or message/global, RFC 6532) part, not itself encoded. */
export function isMessage(entity: Entity): boolean {
	const { mediaType } = entity.contentType;
	if (mediaType !== 'message/rfc822' && mediaType !== 'message/global')
		return false;
	const encoding = entity.headers
		.get('content-transfer-encoding')
		?.trim()
		.toLowerCase();
	return encoding !== 'base64' && encoding !== 'quoted-printable';
}
