import { parseCommand, parsePathCommand } from '../protocol/command';
import { DataReader } from '../protocol/data';
import { reply } from '../protocol/reply';
import { authenticate, continueAuth } from './auth';
import { type Connection, emptyTransaction } from './connection';

function nonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++)
		if (text.charCodeAt(i) > 0x7f) return true;
	return false;
}

function ehloLines(connection: Connection): string[] {
	const { settings, state } = connection;
	const lines = [
		`${settings.options.hostname} greets ${state.helo}`,
		'PIPELINING',
		`SIZE ${settings.maxMessageSize}`,
		'8BITMIME',
		'SMTPUTF8',
		'ENHANCEDSTATUSCODES',
	];
	if (settings.options.tls && !state.secure) lines.push('STARTTLS');
	if (
		settings.options.authenticate &&
		state.secure &&
		state.user === undefined
	) {
		lines.push('AUTH PLAIN LOGIN');
	}
	return lines;
}

async function hello(
	connection: Connection,
	argument: string,
	esmtp: boolean,
): Promise<void> {
	if (
		!/^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.Iv]+\])$/.test(
			argument,
		)
	) {
		connection.fail(
			reply(501, '5.5.4', `Syntax: ${esmtp ? 'EHLO' : 'HELO'} hostname`),
		);
		return;
	}
	const { state } = connection;
	state.helo = argument;
	state.esmtp = esmtp;
	// RFC 5321 §4.1.4: EHLO or HELO resets a transaction in progress.
	state.transaction = emptyTransaction();
	connection.send(
		esmtp
			? reply(250, undefined, ehloLines(connection))
			: reply(
					250,
					undefined,
					`${connection.settings.options.hostname} greets ${argument}`,
				),
	);
}

async function mail(connection: Connection, argument: string): Promise<void> {
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
		? await connection.hook(() =>
				options.onMailFrom?.(path, connection.session),
			)
		: undefined;
	if (refused) return connection.send(refused);
	state.transaction = { from: path.address, to: [], smtputf8, body };
	connection.send(reply(250, '2.1.0', 'OK'));
}

async function rcpt(connection: Connection, argument: string): Promise<void> {
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
	if (state.user === undefined && !(await settings.isLocal(path.domain))) {
		return connection.fail(reply(554, '5.7.1', 'Relay access denied'));
	}
	const options = settings.options;
	const refused = options.onRcptTo
		? await connection.hook(() => options.onRcptTo?.(path, connection.session))
		: undefined;
	if (refused) return connection.send(refused);
	state.transaction.to.push(path.address);
	connection.send(reply(250, '2.1.5', 'OK'));
}

function data(connection: Connection, argument: string): void {
	const { state } = connection;
	const refusal =
		argument !== ''
			? reply(501, '5.5.4', 'Syntax: DATA')
			: state.transaction.from === undefined
				? reply(503, '5.5.1', 'Send MAIL first')
				: state.transaction.to.length === 0
					? reply(554, '5.5.1', 'No valid recipients')
					: undefined;
	if (refusal) {
		connection.fail(refusal);
		return;
	}
	connection.reader = new DataReader();
	connection.content = [];
	state.waiting = 'data';
	connection.send(reply(354, undefined, 'End data with <CR><LF>.<CR><LF>'));
}

function startTls(connection: Connection, argument: string): void {
	const { state, settings, transport } = connection;
	const refusal = !settings.options.tls
		? reply(454, '4.7.0', 'TLS not available')
		: state.secure
			? reply(503, '5.5.1', 'TLS already active')
			: argument !== ''
				? reply(501, '5.5.4', 'Syntax: STARTTLS')
				: undefined;
	if (refusal) {
		connection.fail(refusal);
		return;
	}
	connection.send(reply(220, '2.0.0', 'Ready to start TLS'));
	connection.discardInput();
	transport.startTls();
	// RFC 3207 §4.2: everything learnt before TLS is forgotten.
	state.secure = true;
	state.helo = undefined;
	state.esmtp = false;
	state.transaction = emptyTransaction();
}

/** Runs one command line, or the client's answer to an AUTH challenge. */
export async function runCommand(
	connection: Connection,
	line: string,
): Promise<void> {
	const { state } = connection;
	if (state.waiting !== 'command') return continueAuth(connection, line);
	const { verb, argument } = parseCommand(line);
	switch (verb) {
		case 'EHLO':
			return hello(connection, argument, true);
		case 'HELO':
			return hello(connection, argument, false);
		case 'MAIL':
			return mail(connection, argument);
		case 'RCPT':
			return rcpt(connection, argument);
		case 'DATA':
			return data(connection, argument);
		case 'RSET':
			state.transaction = emptyTransaction();
			return connection.send(reply(250, '2.0.0', 'OK'));
		case 'NOOP':
			return connection.send(reply(250, '2.0.0', 'OK'));
		case 'VRFY':
			return connection.send(
				reply(
					252,
					'2.5.0',
					'Cannot VRFY user; send the message and it will be tried',
				),
			);
		case 'HELP':
			return connection.send(reply(214, '2.0.0', 'See RFC 5321'));
		case 'QUIT':
			return connection.close(
				reply(
					221,
					'2.0.0',
					`${connection.settings.options.hostname} closing connection`,
				),
			);
		case 'STARTTLS':
			return startTls(connection, argument);
		case 'AUTH':
			return authenticate(connection, argument);
		default:
			return connection.fail(reply(500, '5.5.2', 'Command unrecognized'));
	}
}
