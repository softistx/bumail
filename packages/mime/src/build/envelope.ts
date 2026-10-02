import { MimeError } from '../errors';
import {
	checkAddress,
	hasStrayText,
	type Mailbox,
	mailboxesOf,
	parseAddressList,
} from '../headers/addresses';
import type { AddressInput, MessageOptions } from './options';

/** Who a message goes from and to, as SMTP's `MAIL FROM` and `RCPT TO` need it. */
export interface Envelope {
	readonly from: string;
	readonly to: readonly string[];
}

export function list(
	input: AddressInput | readonly AddressInput[] | undefined,
): AddressInput[] {
	if (input === undefined) return [];
	return Array.isArray(input) ? [...input] : [input as AddressInput];
}

/**
 * The mailboxes of a string or an object, each address checked for headers
 * and SMTP alike. A string may list several, groups included: none is
 * dropped.
 */
export function toMailboxes(input: AddressInput, caller: string): Mailbox[] {
	const mailboxes =
		typeof input === 'string' ? mailboxesOf(parseAddressList(input)) : [input];
	if (
		mailboxes.length === 0 ||
		(typeof input === 'string' && hasStrayText(input))
	) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`${caller}: "${JSON.stringify(input).slice(1, -1)}" is not an e-mail address`,
		);
	}
	for (const mailbox of mailboxes) checkAddress(mailbox.address, caller);
	return mailboxes;
}

/** The one mailbox of `from` or `sender`: a string listing several is refused. */
export function toMailbox(input: AddressInput, caller: string): Mailbox {
	const mailboxes = toMailboxes(input, caller);
	if (mailboxes.length > 1) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`${caller}: "${JSON.stringify(input).slice(1, -1)}" holds ${mailboxes.length} addresses where one is expected`,
		);
	}
	return mailboxes[0] as Mailbox;
}

/**
 * The envelope of a message: its sender, and every recipient — To, Cc and
 * Bcc — once. Every address is checked: none can carry a line break or an
 * angle bracket into an SMTP command.
 */
export function envelopeOf(options: MessageOptions): Envelope {
	const to = [
		...list(options.to),
		...list(options.cc),
		...list(options.bcc),
	].flatMap((input) =>
		toMailboxes(input, 'envelopeOf()').map((mailbox) => mailbox.address),
	);
	return {
		from: toMailbox(options.from, 'envelopeOf()').address,
		to: [...new Set(to)],
	};
}
