import { parseCommand } from '../protocol/command';
import { isHelloName } from '../protocol/path';
import { reply } from '../protocol/reply';
import { authenticate, continueAuth } from './auth';
import type { Connection } from './connection';
import { emptyTransaction } from './state';
import { mail, rcpt } from './transaction';

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
	if (!isHelloName(argument)) {
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
		// What the client pipelined after a refused DATA is message content,
		// not commands: running it would let a message smuggle commands in.
		connection.input.drop();
		return;
	}
	connection.send(reply(354, undefined, 'End data with <CR><LF>.<CR><LF>'));
	connection.input.beginData();
}

async function startTls(
	connection: Connection,
	argument: string,
): Promise<void> {
	const { state, settings } = connection;
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
	connection.input.ignore();
	// The 220 must reach the client in clear before the handshake starts.
	await connection.transport.drained();
	if (connection.closed) return;
	connection.transport.startTls();
	connection.input.accept();
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
			return connection.quit(
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
