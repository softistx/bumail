import type { Connection } from './connection';

/**
 * What the server announces (RFC 9051 §6.1.1), as the session stands. On a
 * clear connection: STARTTLS and LOGINDISABLED, and no AUTH= at all; once
 * encrypted and before login: AUTH=PLAIN and SASL-IR. IMAP4rev1 is
 * announced beside IMAP4rev2 (RFC 9051 Appendix E): a client that does not
 * ENABLE IMAP4rev2 is served as IMAP4rev1.
 */
export function capabilities(connection: Connection): string[] {
	const { secure, phase } = connection.state;
	const list = ['IMAP4rev1', 'IMAP4rev2'];
	if (!secure) list.push('STARTTLS', 'LOGINDISABLED');
	else if (phase === 'not-authenticated') list.push('AUTH=PLAIN', 'SASL-IR');
	list.push(
		'LITERAL+',
		'ENABLE',
		'IDLE',
		'NAMESPACE',
		'UNSELECT',
		'MOVE',
		'CHILDREN',
		'SPECIAL-USE',
		'LIST-EXTENDED',
		'LIST-STATUS',
		'ESEARCH',
		`APPENDLIMIT=${connection.settings.maxMessageSize}`,
	);
	return list;
}
