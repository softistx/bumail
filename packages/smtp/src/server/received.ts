import { isIPv6 } from 'node:net';
import type { Connection } from './connection';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];

const two = (n: number) => String(n).padStart(2, '0');

/** An RFC 5322 §3.3 date-time, in UTC. */
export function dateTime(date: Date): string {
	return `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}

/** RFC 3848: how the message came — SMTP, ESMTP, then S for TLS and A for AUTH. */
export function protocolOf(
	esmtp: boolean,
	secure: boolean,
	authenticated: boolean,
): string {
	if (!esmtp) return 'SMTP';
	return `ESMTP${secure ? 'S' : ''}${authenticated ? 'A' : ''}`;
}

/** The client's address as a domain literal (RFC 5321 §4.1.3): an IPv6 address is tagged `IPv6:`. */
export function addressLiteral(address: string): string {
	return isIPv6(address) ? `IPv6:${address}` : printable(address);
}

/** Keeps a client-given name printable in a header: anything else becomes `?`. */
function printable(text: string): string {
	let out = '';
	for (const char of text) {
		const code = char.charCodeAt(0);
		out += code > 0x20 && code < 0x7f ? char : '?';
	}
	return out;
}

/** Whether an address can go into the `for` clause as it is: printable, and no `;` to end the clause early. */
function plain(address: string): boolean {
	return printable(address) === address && !address.includes(';');
}

/**
 * The Received field the server puts on top (RFC 5321 §4.4): who sent the
 * message, from where, how, to whom when there is one recipient, and when.
 */
export function receivedField(
	connection: Connection,
	recipients: readonly string[],
	id: string,
	now = new Date(),
): string {
	const { state, transport, settings } = connection;
	const lines = [
		`Received: from ${printable(state.helo ?? 'unknown')} ([${addressLiteral(transport.remoteAddress)}])`,
		`\tby ${settings.options.hostname} with ${protocolOf(state.esmtp, state.secure, state.user !== undefined)} id ${id}`,
	];
	const [recipient] = recipients;
	if (recipients.length === 1 && recipient !== undefined && plain(recipient)) {
		lines.push(`\tfor <${recipient}>`);
	}
	lines[lines.length - 1] += `; ${dateTime(now)}`;
	return `${lines.join('\r\n')}\r\n`;
}
