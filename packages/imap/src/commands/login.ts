import { echo } from '../protocol/echo';
import { type Credentials, decodePlain } from '../protocol/sasl';
import { capabilities } from '../server/capabilities';
import { answerFailure } from '../server/failure';
import { guarded } from '../server/guard';
import {
	bad,
	type Command,
	type Context,
	NOT_AUTHENTICATED,
	no,
	ok,
} from './context';

/** Failed logins before the server hangs up. */
const MAX_AUTH_FAILURES = 3;

const PRIVACY = '[PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first';

async function fail(context: Context): Promise<void> {
	const { connection } = context;
	connection.state.authFailures++;
	await no(context, '[AUTHENTICATIONFAILED] Authentication failed');
	if (connection.state.authFailures >= MAX_AUTH_FAILURES) {
		await connection.close('Too many failed logins, closing');
	}
}

/** Asks `authenticate`, checks the account it names, and logs the session in. */
async function login(
	context: Context,
	credentials: Credentials,
): Promise<void> {
	const { connection } = context;
	if (
		credentials.authorizationId !== undefined &&
		credentials.authorizationId !== credentials.username
	) {
		// A session acts as the user it authenticated as, never as another.
		return fail(context);
	}
	const { authenticate } = connection.settings.options;
	const answer = await guarded(connection, 'authenticate', () =>
		authenticate(credentials, connection.session),
	);
	if (answer.failed) {
		return no(context, '[UNAVAILABLE] Temporary authentication failure');
	}
	const accountId = answer.value;
	if (typeof accountId !== 'string' || accountId === '') return fail(context);
	const account = await connection.settings.store.getAccount(accountId);
	if (!account) {
		connection.report(
			new Error(
				`authenticate answered the account "${accountId}", which the store does not have`,
			),
		);
		return no(context, '[UNAVAILABLE] Temporary authentication failure');
	}
	connection.loggedIn(credentials.username, accountId);
	await ok(
		context,
		`[CAPABILITY ${capabilities(connection).join(' ')}] Logged in`,
	);
}

/** LOGIN (RFC 9051 §6.2.3), refused before its arguments are read on a clear connection. */
export const LOGIN: Command = {
	phases: NOT_AUTHENTICATED,
	async run(context) {
		if (!context.connection.state.secure) return no(context, PRIVACY);
		const { cursor } = context;
		const username = cursor.astring();
		cursor.sp();
		const password = cursor.astring();
		cursor.end();
		await login(context, { mechanism: 'LOGIN', username, password });
	},
};

async function plainResponse(
	context: Context,
	response: string,
): Promise<void> {
	if (response === '*') return bad(context, 'Authentication cancelled');
	const credentials = decodePlain(response === '=' ? '' : response);
	if (!credentials) return bad(context, 'Cannot decode the PLAIN response');
	await login(context, credentials);
}

/** AUTHENTICATE PLAIN (RFC 9051 §6.2.2), with SASL-IR's initial response (RFC 4959). */
export const AUTHENTICATE: Command = {
	phases: NOT_AUTHENTICATED,
	async run(context) {
		const { connection, cursor } = context;
		if (!connection.state.secure) return no(context, PRIVACY);
		const mechanism = cursor.atom('a SASL mechanism').toUpperCase();
		if (mechanism !== 'PLAIN') {
			return no(
				context,
				`[CANNOT] ${echo(mechanism)} is not supported: use PLAIN`,
			);
		}
		if (cursor.take(' ')) {
			const initial = cursor.atom('an initial response');
			cursor.end();
			return plainResponse(context, initial);
		}
		cursor.end();
		connection.input.expectLine((line) =>
			connection.exclusive(() =>
				plainResponse(context, line).catch((error) =>
					answerFailure(connection, context.tag, error),
				),
			),
		);
		await connection.send(['+ \r\n']);
	},
};
