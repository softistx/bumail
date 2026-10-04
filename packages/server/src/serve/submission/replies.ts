import { type Reply, reply } from '@bumail/smtp';

/** The replies submission sends of its own, besides the MX's and those of `@bumail/smtp`. */

/** MAIL FROM an address that is neither the user's nor one of its aliases. */
export function senderNotYours(address: string): Reply {
	return reply(553, '5.7.1', `Not authorized to send as <${address}>`);
}

export const FROM_NOT_YOURS = reply(
	550,
	'5.7.1',
	'The From field names an address that is not yours',
);
export const FROM_COUNT = reply(
	550,
	'5.6.0',
	'The message needs exactly one From field',
);
export const FROM_NO_ADDRESS = reply(
	550,
	'5.6.0',
	'The From field must name your address',
);
export const ADDRESS_LITERAL = reply(
	550,
	'5.7.1',
	'Mail to an address literal is not sent from here',
);
export const ADDRESS_UNSENDABLE = reply(
	553,
	'5.1.3',
	'The address is not one this server can send to',
);
export const QUEUE_FULL = reply(
	452,
	'4.3.1',
	'The queue is full, try again later',
);
export const QUEUE_TOO_BIG = reply(
	552,
	'5.3.4',
	'Message too big for the queue',
);
export const QUEUE_TOO_MANY = reply(452, '4.5.3', 'Too many recipients');
