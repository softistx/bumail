import type { Context } from '../commands/context';
import { Cursor, type Framed } from '../protocol/cursor';
import { tagged } from '../protocol/response';
import { COMMANDS, UID_COMMANDS } from './commands';
import type { Connection } from './connection';
import { answerFailure } from './failure';

/**
 * Runs one command: its tag, its name (`UID` and the next one for a UID
 * command), the state check, then the handler. A grammar error is `BAD`;
 * a store's refusal `NO`, with a response code; anything else is reported
 * to `onError` and answered `NO [SERVERBUG]`. Nothing a client sends
 * makes it throw.
 */
export async function dispatch(
	connection: Connection,
	framed: Framed,
): Promise<void> {
	const cursor = new Cursor(framed);
	const tag = cursor.astringAtom();
	if (tag === undefined || tag.includes('+')) {
		return connection.untagged('BAD Missing or invalid tag');
	}
	try {
		if (!cursor.take(' ')) cursor.fail('Missing command');
		let name = cursor.atom('a command').toUpperCase();
		const uid = name === 'UID';
		if (uid) {
			cursor.sp();
			name = cursor.atom('a command').toUpperCase();
		}
		const command = (uid ? UID_COMMANDS : COMMANDS)[name];
		if (!command) {
			return connection.send(
				tagged(tag, 'BAD', `Unknown command ${uid ? 'UID ' : ''}${name}`),
			);
		}
		if (!command.phases.includes(connection.state.phase)) {
			return connection.send(
				tagged(
					tag,
					'BAD',
					`${name} is not valid in the ${connection.state.phase} state`,
				),
			);
		}
		if (command.bare) cursor.end();
		else cursor.sp();
		const context: Context = { connection, tag, cursor, uid, name };
		await command.run(context);
	} catch (error) {
		await answerFailure(connection, tag, error);
	}
}
