import { reply } from '../protocol/reply';
import {
	type Credentials,
	decodeLoginStep,
	decodePlain,
} from '../protocol/sasl';
import type { Connection } from './connection';

/** Failed AUTH attempts before the server hangs up. */
const MAX_AUTH_FAILURES = 3;

async function check(
	connection: Connection,
	credentials: Credentials | undefined,
): Promise<void> {
	const { state, settings } = connection;
	state.waiting = 'command';
	state.loginUser = undefined;
	if (credentials === undefined) {
		return connection.fail(reply(501, '5.5.2', 'Cannot decode the response'));
	}
	if (
		credentials.authorizationId !== undefined &&
		credentials.authorizationId !== credentials.username
	) {
		// A session acts as the user it authenticated as, never as another.
		return refuse(connection);
	}
	const { authenticate } = settings.options;
	const answer = await connection.check('authenticate', () =>
		authenticate?.(credentials, connection.session),
	);
	if (answer.failed) {
		// RFC 4954 §6: a failure of the server's own, not of the credentials.
		return connection.send(
			reply(454, '4.7.0', 'Temporary authentication failure'),
		);
	}
	const ok = answer.value === true;
	if (ok) {
		state.user = credentials.username;
		return connection.send(reply(235, '2.7.0', 'Authentication successful'));
	}
	refuse(connection);
}

function refuse(connection: Connection): void {
	const { state, settings } = connection;
	state.authFailures++;
	if (state.authFailures >= MAX_AUTH_FAILURES) {
		const { hostname } = settings.options;
		connection.close(
			reply(
				421,
				'4.7.0',
				`${hostname} Too many failed authentications, closing`,
			),
		);
		return;
	}
	connection.fail(reply(535, '5.7.8', 'Authentication credentials invalid'));
}

/** `AUTH PLAIN [initial]` or `AUTH LOGIN [initial]` (RFC 4954), over TLS only. */
export async function authenticate(
	connection: Connection,
	argument: string,
): Promise<void> {
	const { state, settings } = connection;
	if (!settings.options.authenticate)
		return connection.fail(reply(502, '5.5.1', 'AUTH not available'));
	if (!state.secure)
		return connection.fail(
			reply(
				538,
				'5.7.11',
				'Encryption required for requested authentication mechanism',
			),
		);
	if (state.helo === undefined || !state.esmtp)
		return connection.fail(reply(503, '5.5.1', 'Send EHLO first'));
	if (state.user !== undefined)
		return connection.fail(reply(503, '5.5.1', 'Already authenticated'));
	if (state.transaction.from !== undefined)
		return connection.fail(
			reply(503, '5.5.1', 'AUTH not allowed during a transaction'),
		);
	const [mechanism = '', initial, extra] = argument.split(' ');
	if (extra !== undefined)
		return connection.fail(
			reply(501, '5.5.4', 'Syntax: AUTH mechanism [initial-response]'),
		);
	switch (mechanism.toUpperCase()) {
		case 'PLAIN':
			if (initial === undefined) {
				state.waiting = 'auth-plain';
				return connection.send(reply(334, undefined, ''));
			}
			return check(connection, decodePlain(initial === '=' ? '' : initial));
		case 'LOGIN':
			if (initial === undefined) {
				state.waiting = 'auth-login-user';
				return connection.send(reply(334, undefined, 'VXNlcm5hbWU6'));
			}
			return loginUser(connection, initial);
		default:
			return connection.fail(
				reply(504, '5.5.4', 'Unrecognized authentication type'),
			);
	}
}

function loginUser(
	connection: Connection,
	response: string,
): void | Promise<void> {
	const user = decodeLoginStep(response);
	if (!user) return check(connection, undefined);
	connection.state.loginUser = user;
	connection.state.waiting = 'auth-login-password';
	connection.send(reply(334, undefined, 'UGFzc3dvcmQ6'));
}

/** The client's line after a 334 challenge. */
export async function continueAuth(
	connection: Connection,
	line: string,
): Promise<void> {
	const { state } = connection;
	if (line === '*') {
		state.waiting = 'command';
		state.loginUser = undefined;
		return connection.fail(reply(501, '5.0.0', 'Authentication cancelled'));
	}
	switch (state.waiting) {
		case 'auth-plain':
			return check(connection, decodePlain(line));
		case 'auth-login-user':
			return loginUser(connection, line);
		default: {
			const password = decodeLoginStep(line);
			const username = state.loginUser ?? '';
			return check(
				connection,
				password ? { mechanism: 'LOGIN', username, password } : undefined,
			);
		}
	}
}
