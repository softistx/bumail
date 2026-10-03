import { sync } from '../mailbox/sync';
import type { Connection } from '../server/connection';
import { answerFailure } from '../server/failure';
import { AUTHENTICATED, bad, type Command, ok } from './context';

/** One look at the store, in turn with everything else the session does. */
function look(connection: Connection): Promise<void> {
	return connection
		.exclusive(() => sync(connection))
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
	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(async () => {
			await look(connection);
			schedule();
		}, connection.settings.idleInterval * 1000);
	};
	connection.wake = () => {
		if (!stopped) void look(connection);
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
