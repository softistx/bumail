import { type Reply, reply } from '@bumail/smtp';

/** The replies the MX sends of its own, besides those of `@bumail/smtp`. */
export const USER_UNKNOWN = reply(550, '5.1.1', 'User unknown');
export const HEADER_TOO_LARGE = reply(552, '5.3.4', 'Message header too large');
export const NO_RECIPIENT = reply(
	550,
	'5.1.1',
	'No recipient of this message is here any longer',
);
export const DMARC_DEFERRED = reply(
	451,
	'4.7.0',
	'DMARC check failed, try again later',
);
export const NOT_TAKEN = reply(
	451,
	'4.3.0',
	'Message not taken, try again later',
);
export const SPOOL_FULL = reply(
	452,
	'4.3.1',
	'Insufficient system storage, try again later',
);

export const FROM_UNREADABLE = reply(
	550,
	'5.7.1',
	'The From field cannot be evaluated for DMARC: none, several, or not one mailbox',
);

export function dmarcRejected(domain: string): Reply {
	return reply(
		550,
		'5.7.1',
		`Rejected by the DMARC policy of ${domain || 'the sender domain'}`,
	);
}
