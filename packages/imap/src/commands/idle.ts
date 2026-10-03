import { sync } from '../mailbox/sync';
import type { Connection } from '../server/connection';
import { answerFailure } from '../server/failure';
import { AUTHENTICATED, bad, type Command, ok } from './context';

/**
 * One look at the store, in turn with everything else the session does. A
 * look queued behind DONE finds IDLE over and does nothing: an EXPUNGE
 * then would come outside any command (RFC 9051 §7.5.1).
 */
function look(connection: Connection, over: () => boolean): Promise<void> {
	return connection
		.exclusive(async () => (over() ? undefined : sync(connection)))
		.catch((error) => {
			connection.report(error);
		});
}

/**
 * Polls the store every `idleInterval` seconds — and whenever `notify`
 * wakes the session — until stopped. One look at a time: the next is
 * scheduled when the last one ends.
 */
function watch(connection: Connection): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const over = () => stopped;
	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(async () => {
			await look(connection, over);
			schedule();
		}, connection.settings.idleInterval * 1000);
	};
	connection.wake = () => {
		if (!stopped) void look(connection, over);
	};
	schedule();
	return () => {
		stopped = true;
		clearTimeout(timer);
		connection.wake = undefined;
		connection.stopIdle = undefined;
	};
}

/**
 * IDLE (RFC 2177, RFC 9051 §6.3.13): `+ idling`, then EXISTS, EXPUNGE and
 * FETCH FLAGS as the store changes, until the client sends DONE.
 */
export const IDLE: Command = {
	phases: AUTHENTICATED,
	bare: true,
	async run(context) {
		const { connection } = context;
		await connection.send(['+ idling\r\n']);
		if (connection.state.phase === 'selected') await sync(connection);
		if (connection.closed) return;
		connection.stopIdle = watch(connection);
		connection.input.expectLine((line) =>
			connection.exclusive(async () => {
				connection.stopIdle?.();
				try {
					if (line.toUpperCase() === 'DONE')
						await ok(context, 'IDLE terminated');
					else await bad(context, 'Expected DONE');
				} catch (error) {
					await answerFailure(connection, context.tag, error);
				}
			}),
		);
	},
};
