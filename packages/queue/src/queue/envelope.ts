import { isMailbox } from '@bumail/smtp/client';
import { invalid, QueueError } from '../errors';
import { hasControl } from '../text';

/** What `enqueue` takes as the message: its bytes, its text, or a stream of it. */
export type MessageSource = Uint8Array | string | ReadableStream<Uint8Array>;

/** The SMTP envelope of a message to send. */
export interface QueueEnvelope {
	/** The reverse-path, `local@domain`; `''` for the null sender (a bounce of your own). */
	readonly from: string;
	/** One recipient or more, `local@domain` each. */
	readonly to: string | readonly string[];
}

/**
 * An address as SMTP carries it: a local part, `@`, a domain, 254
 * characters at most (RFC 5321 §4.5.3.1.3's path, less its brackets), with
 * no space, no control character and no angle bracket, so it can never
 * break a command line or a header field — and one `sendMail` takes
 * (`isMailbox`, RFC 5321's grammar), so it is refused here, never at
 * delivery, where it would fail its whole domain's group.
 */
const ADDRESS = /^[^\s<>]{1,64}@[^\s<>@]{1,253}$/u;

export function checkAddress(name: string, address: unknown): string {
	if (
		typeof address !== 'string' ||
		address.length > 254 ||
		hasControl(address) ||
		!ADDRESS.test(address) ||
		!isMailbox(address)
	) {
		throw invalid(
			`${name} must be an address, local@domain, not ${JSON.stringify(address)}`,
		);
	}
	return address;
}

/** The recipient's domain, in lowercase: what deliveries are grouped by. */
export const domainOf = (address: string) =>
	address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** The envelope, checked: the sender, and each recipient once, at most `maxRecipients`. */
export function checkEnvelope(
	envelope: QueueEnvelope,
	maxRecipients: number,
): { from: string; to: string[] } {
	if (typeof envelope !== 'object' || envelope === null) {
		throw invalid('The envelope is an object: { from, to }');
	}
	const from = envelope.from === '' ? '' : checkAddress('from', envelope.from);
	const list = typeof envelope.to === 'string' ? [envelope.to] : envelope.to;
	if (!Array.isArray(list) || list.length === 0) {
		throw invalid('to must hold one recipient or more');
	}
	const seen = new Set<string>();
	const to: string[] = [];
	for (const address of list) {
		checkAddress('Each recipient', address);
		const key = `${address.slice(0, address.lastIndexOf('@'))}@${domainOf(address)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		to.push(address);
	}
	if (to.length > maxRecipients) {
		throw new QueueError(
			'TOO_MANY_RECIPIENTS',
			`The message has ${to.length} recipients; the limit is ${maxRecipients}`,
		);
	}
	return { from, to };
}

const tooBig = (max: number) =>
	new QueueError(
		'MESSAGE_TOO_BIG',
		`The message is larger than the limit of ${max} bytes`,
	);

const CR = 0x0d;
const LF = 0x0a;

/**
 * Refuses a message with a CR not followed by an LF, or an LF not after a
 * CR: `sendMail` would refuse it at delivery (`BARE_LINE_BREAK`, SMTP
 * smuggling), failing every recipient.
 */
export function checkLineEnds(bytes: Uint8Array): void {
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		const bare =
			byte === CR
				? bytes[i + 1] !== LF
				: byte === LF && (i === 0 || bytes[i - 1] !== CR);
		if (bare) {
			throw invalid(
				`The message has a bare CR or LF at byte ${i}: every line must end in CRLF`,
			);
		}
	}
}

/** The message's bytes, read to its end but never past `max`: past it, `MESSAGE_TOO_BIG`. */
export async function readMessage(
	source: MessageSource,
	max: number,
): Promise<Uint8Array> {
	if (typeof source === 'string') source = new TextEncoder().encode(source);
	if (source instanceof Uint8Array) {
		if (source.length > max) throw tooBig(max);
		return source.slice();
	}
	if (!(source instanceof ReadableStream)) {
		throw invalid(
			'The message is a Uint8Array, a string or a ReadableStream<Uint8Array>',
		);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = source.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				throw invalid('The message stream must give Uint8Array chunks');
			}
			size += value.length;
			if (size > max) throw tooBig(max);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}
