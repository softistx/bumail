import { normalizeName } from '@bumail/dns';
import { parseHeaderBlock } from '@bumail/mime';
import {
	HeaderTooLarge,
	type MessageInput,
	type SplitMessage,
	splitMessage,
} from '../dkim/message';
import { clip } from '../dkim/tags';
import { bytesOf, lowerAscii, trimWspEnd } from '../text';
import { fromMailbox } from './from-mailbox';

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

const PROBLEMS = {
	empty: 'From holds no address',
	unparsable: 'From does not parse as one mailbox',
	several: 'From holds more than one address',
	group: 'From holds a group, not a mailbox',
} as const;

/** The one domain of one From field's value, read strictly (see `from-mailbox.ts`). */
function domainOf(value: string): Author {
	const found = fromMailbox(value);
	if ('problem' in found) return refuse(PROBLEMS[found.problem]);
	const notADomain = refuse(
		`the From domain ${JSON.stringify(clip(found.domain))} is not a domain name`,
	);
	if (found.literal) return notADomain;
	try {
		return { domain: normalizeName(found.domain) };
	} catch {
		return notADomain;
	}
}

/**
 * How many fields of the header are named From, a bare CR or LF counted
 * as a line break: `parseHeaderBlock` breaks lines at LF only, and a
 * reader that also breaks at a bare CR would see a second From there.
 */
function fromFields(header: string): number {
	let count = 0;
	for (const line of header.split(/\r\n|\r|\n/)) {
		const colon = line.indexOf(':');
		if (colon <= 0 || line[0] === ' ' || line[0] === '\t') continue;
		if (lowerAscii(trimWspEnd(line.slice(0, colon))) === 'from') count++;
	}
	return count;
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
	if (froms.length > 1 || fromFields(split.header) > 1) {
		return refuse('the message has more than one From header');
	}
	if (froms.length === 0) return refuse('the message has no From header');
	return domainOf(froms[0] ?? '');
}
