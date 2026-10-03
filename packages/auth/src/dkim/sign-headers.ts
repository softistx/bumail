import { AuthError } from '../errors';
import { lowerAscii } from '../text';
import type { RawField } from './headers';
import { FIELD_NAME } from './names';

/**
 * The fields signed by default, when present: RFC 6376 §5.4.1's
 * recommended ones, Message-ID, which it calls useful, and MIME-Version
 * and Content-Type, which say how the body is to be read.
 */
export const RECOMMENDED_HEADERS: readonly string[] = [
	'from',
	'reply-to',
	'subject',
	'date',
	'to',
	'cc',
	'message-id',
	'resent-date',
	'resent-from',
	'resent-to',
	'resent-cc',
	'in-reply-to',
	'references',
	'list-id',
	'list-help',
	'list-unsubscribe',
	'list-subscribe',
	'list-post',
	'list-owner',
	'list-archive',
	'mime-version',
	'content-type',
];

/**
 * The fields listed once more than the message has them, when present
 * (§5.4.2, over-signing): the extra entry signs "no further one", so a
 * copy added in transit, which a reader may be shown instead of the
 * signed one, breaks the signature.
 */
export const OVERSIGNED_HEADERS: readonly string[] = [
	'from',
	'subject',
	'date',
	'to',
	'cc',
	'reply-to',
	'message-id',
	'content-type',
	'mime-version',
];

/** `headers` as `h=` writes them, lowercased; `undefined` for the default. Checked before the message is read. */
export function givenHeaders(
	headers: readonly string[] | undefined,
): string[] | undefined {
	if (headers === undefined) return undefined;
	if (!Array.isArray(headers))
		throw new AuthError(
			'INVALID_OPTION',
			'signDkim(): headers must be an array of header field names',
		);
	if (
		headers.some((name) => typeof name !== 'string' || !FIELD_NAME.test(name))
	)
		throw new AuthError(
			'INVALID_OPTION',
			'signDkim(): headers holds a name that is not a header field name',
		);
	const names = headers.map(lowerAscii);
	if (!names.includes('from'))
		throw new AuthError(
			'INVALID_OPTION',
			'signDkim(): headers must include from (RFC 6376 §5.4)',
		);
	return names;
}

/** Whether the message has a From field, which `signDkim` refuses to sign without. */
export function hasFrom(fields: readonly RawField[]): boolean {
	return fields.some((field) => field.name === 'from');
}

/**
 * The names `h=` lists: `given` exactly, or by default each recommended
 * field once per instance, then each over-signed field present once more.
 */
export function headersToSign(
	given: readonly string[] | undefined,
	fields: readonly RawField[],
): string[] {
	if (given !== undefined) return [...given];
	const names = fields.map((field) => field.name);
	return [
		...names.filter((name) => RECOMMENDED_HEADERS.includes(name)),
		...OVERSIGNED_HEADERS.filter((name) => names.includes(name)),
	];
}
