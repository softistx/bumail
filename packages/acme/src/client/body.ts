import { isArray } from '../encoding';
import { AcmeError } from '../errors';

/** The largest JSON answer read: a directory, an account, an order of 100 names, an authorization. */
export const MAX_JSON_BYTES = 256 * 1024;
/** The largest certificate chain read: a leaf and a few intermediates are a few KiB. */
export const MAX_CERTIFICATE_BYTES = 1024 * 1024;

/**
 * The bytes of an answer's body, at most `max`: refused before reading by
 * its `Content-Length`, and while reading once past `max`, the rest
 * cancelled unread.
 */
export async function readBounded(
	response: Response,
	max: number,
	where: string,
): Promise<Uint8Array> {
	const tooLarge = () =>
		new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's answer is over ${max} bytes`,
			{ status: response.status },
		);
	const length = Number(response.headers.get('content-length'));
	if (Number.isFinite(length) && length > max) {
		await response.body?.cancel().catch(() => {});
		throw tooLarge();
	}
	const body = response.body;
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** JSON from bytes, or undefined when they are not JSON. */
export function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

/** Whether a value is a plain JSON object. */
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !isArray(value);
}

/** `isObject` without narrowing: for typed options, whose members stay typed. */
export function isOptions(value: unknown): boolean {
	return isObject(value);
}
