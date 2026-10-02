import { parsePathCommand } from '../protocol/command';
import { reply } from '../protocol/reply';
import type { Connection } from './connection';
import { LOCAL_ERROR } from './guard';

function nonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++)
		if (text.charCodeAt(i) > 0x7f) return true;
	return false;
}

/** `MAIL FROM:<path> [SIZE=] [BODY=] [SMTPUTF8] [AUTH=]` (RFC 5321 §4.1.1.2). */
export async function mail(
	connection: Connection,
	argument: string,
): Promise<void> {
	const { state, settings } = connection;
	if (state.helo === undefined)
		return connection.fail(reply(503, '5.5.1', 'Send EHLO first'));
	if (state.transaction.from !== undefined) {
		return connection.fail(reply(503, '5.5.1', 'Nested MAIL command'));
	}
	if (settings.mode === 'submission' && state.user === undefined) {
		return connection.fail(reply(530, '5.7.0', 'Authentication required'));
	}
	const command = parsePathCommand(argument, 'FROM');
	if (!command)
		return connection.fail(reply(501, '5.5.4', 'Syntax: MAIL FROM:<address>'));
	const { path, parameters } = command;
	let body: '7BIT' | '8BITMIME' = '7BIT';
	let smtputf8 = false;
	for (const [key, value] of Object.entries(parameters)) {
		if (!state.esmtp)
			return connection.fail(reply(555, '5.5.4', `${key} needs EHLO`));
		if (key === 'SIZE') {
			if (!/^\d+$/.test(value))
				return connection.fail(reply(501, '5.5.4', 'Syntax: SIZE=<bytes>'));
			if (Number(value) > settings.maxMessageSize) {
				return connection.fail(
					reply(552, '5.3.4', 'Message too big for system'),
				);
			}
		} else if (key === 'BODY') {
			const kind = value.toUpperCase();
			if (kind !== '7BIT' && kind !== '8BITMIME') {
				return connection.fail(reply(501, '5.5.4', 'BODY is 7BIT or 8BITMIME'));
			}
			body = kind;
		} else if (key === 'SMTPUTF8' && value === '') {
			smtputf8 = true;
		} else if (key === 'AUTH') {
			// RFC 4954 §5: the original submitter; taken and not passed on.
		} else {
			return connection.fail(reply(555, '5.5.4', `${key} is not supported`));
		}
	}
	if (!smtputf8 && nonAscii(path.address)) {
		return connection.fail(
			reply(553, '5.6.7', 'A non-ASCII address needs SMTPUTF8'),
		);
	}
	const options = settings.options;
	const refused = options.onMailFrom
		? await connection.hook('onMailFrom', () =>
				options.onMailFrom?.(path, connection.session),
			)
		: undefined;
	if (refused) return connection.send(refused);
	state.transaction = { from: path.address, to: [], smtputf8, body };
	connection.send(reply(250, '2.1.0', 'OK'));
}

/** `RCPT TO:<path>` (RFC 5321 §4.1.1.3), where relaying is refused without AUTH. */
export async function rcpt(
	connection: Connection,
	argument: string,
): Promise<void> {
	const { state, settings } = connection;
	if (state.transaction.from === undefined)
		return connection.fail(reply(503, '5.5.1', 'Send MAIL first'));
	const command = parsePathCommand(argument, 'TO');
	if (!command)
		return connection.fail(reply(501, '5.5.4', 'Syntax: RCPT TO:<address>'));
	const { path, parameters } = command;
	if (Object.keys(parameters).length > 0) {
		return connection.fail(
			reply(555, '5.5.4', `${Object.keys(parameters)[0]} is not supported`),
		);
	}
	if (!state.transaction.smtputf8 && nonAscii(path.address)) {
		return connection.fail(
			reply(553, '5.6.7', 'A non-ASCII address needs SMTPUTF8'),
		);
	}
	if (state.transaction.to.length >= settings.maxRecipients) {
		return connection.send(reply(452, '4.5.3', 'Too many recipients'));
	}
	// Never an open relay: a domain this server does not host takes AUTH.
	if (state.user === undefined) {
		const local = await connection.check('localDomains', () =>
			settings.isLocal(path.domain),
		);
		if (local.failed) return connection.send(LOCAL_ERROR);
		if (local.value !== true) {
			return connection.fail(reply(554, '5.7.1', 'Relay access denied'));
		}
	}
	const options = settings.options;
	const refused = options.onRcptTo
		? await connection.hook('onRcptTo', () =>
				options.onRcptTo?.(path, connection.session),
			)
		: undefined;
	if (refused) return connection.send(refused);
	state.transaction.to.push(path.address);
	connection.send(reply(250, '2.1.5', 'OK'));
}
