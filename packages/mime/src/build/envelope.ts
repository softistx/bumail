import { MimeError } from '../errors';
import {
	checkAddress,
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

/** A mailbox from a string or an object, its address checked for headers and SMTP alike. */
export function toMailbox(input: AddressInput, caller: string): Mailbox {
	const mailbox =
		typeof input === 'string' ? mailboxesOf(parseAddressList(input))[0] : input;
	if (!mailbox) {
		throw new MimeError(
			'INVALID_ADDRESS',
			`${caller}: "${JSON.stringify(input).slice(1, -1)}" is not an e-mail address`,
		);
	}
	checkAddress(mailbox.address, caller);
	return mailbox;
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
	].map((input) => toMailbox(input, 'envelopeOf()').address);
	return {
		from: toMailbox(options.from, 'envelopeOf()').address,
		to: [...new Set(to)],
	};
}
