import { normalizeName } from '@bumail/dns';
import { mailboxesOf, parseAddressList, parseHeaderBlock } from '@bumail/mime';
import {
	HeaderTooLarge,
	type MessageInput,
	type SplitMessage,
	splitMessage,
} from '../dkim/message';
import { clip } from '../dkim/tags';
import { bytesOf } from '../text';

/**
 * The RFC5322.From domain (RFC 7489 §6.6.1), or why there is none to
 * evaluate. Only the header is read: a stream is read up to its blank
 * line, then cancelled.
 */
export type Author =
	| { readonly domain: string }
	| {
			readonly result: 'none' | 'temperror' | 'permerror';
			readonly reason: string;
	  };

function refuse(reason: string): Author {
	return { result: 'permerror', reason };
}

/** The one domain of one From field's value. */
function domainOf(value: string): Author {
	const addresses = parseAddressList(value);
	const mailboxes = mailboxesOf(addresses);
	if (mailboxes.length === 0) {
		return addresses.length > 0
			? { result: 'none', reason: 'From holds a group with no address' }
			: refuse('From holds no address DMARC can read');
	}
	if (mailboxes.length > 1) return refuse('From holds more than one address');
	const address = mailboxes[0]?.address ?? '';
	const at = address.lastIndexOf('@');
	if (at < 0) return refuse('From holds no address DMARC can read');
	const written = address.slice(at + 1);
	try {
		return { domain: normalizeName(written) };
	} catch {
		return refuse(
			`the From domain ${JSON.stringify(clip(written))} is not a domain name`,
		);
	}
}

/** The From domain of `message`, its header bounded by `maxHeaderBytes`. */
export async function authorOf(
	message: MessageInput,
	maxHeaderBytes: number,
): Promise<Author> {
	let split: SplitMessage;
	try {
		split = await splitMessage(message, maxHeaderBytes);
	} catch (error) {
		if (error instanceof HeaderTooLarge) {
			return refuse(
				`the header is larger than maxHeaderBytes (${maxHeaderBytes})`,
			);
		}
		return {
			result: 'temperror',
			reason: `the message could not be read: ${String(error)}`,
		};
	}
	await split.cancel();
	const froms = parseHeaderBlock(bytesOf(split.header)).getAll('from');
	if (froms.length === 0) return refuse('the message has no From header');
	if (froms.length > 1)
		return refuse('the message has more than one From header');
	return domainOf(froms[0] ?? '');
}
