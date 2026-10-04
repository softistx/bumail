import { QueueError } from '../errors';
import type { Keys } from './connect';
import type { RedisQueueClient } from './options';
import { SCHEMA, type Script } from './scripts';

/** Redis no longer has the script: restarted, failed over, or `SCRIPT FLUSH`ed. */
const isNoScript = (error: unknown) =>
	error instanceof Error && error.message.startsWith('NOSCRIPT');

/**
 * Runs a script by its SHA-1 (`EVALSHA`), or, when Redis does not have
 * it, by its source (`EVAL`), which also keeps it for the next call.
 * Either way Redis runs it whole.
 */
export async function run(
	client: RedisQueueClient,
	script: Script,
	keys: string[],
	args: (string | Uint8Array)[],
): Promise<unknown> {
	const rest = [`${keys.length}`, ...keys, ...args];
	try {
		return await client.send('EVALSHA', [script.sha, ...rest]);
	} catch (error) {
		if (!isNoScript(error)) throw error;
		return client.send('EVAL', [script.source, ...rest]);
	}
}

/** The layout of the keys; a change is a new version, and a newer one is refused. */
const LAYOUT = 1;

/** Reads the layout version, writing it on a new queue; a newer one is `INVALID`. */
export async function checkLayout(
	client: RedisQueueClient,
	keys: Keys,
): Promise<void> {
	const found = Number(
		await run(client, SCHEMA, [keys.schema], [keys.prefix, `${LAYOUT}`]),
	);
	if (!Number.isInteger(found) || found < 1) {
		throw new QueueError(
			'INVALID',
			`The key ${keys.schema} does not hold a layout version: is the prefix another application's?`,
		);
	}
	if (found > LAYOUT) {
		throw new QueueError(
			'INVALID',
			`The database is at schema version ${found}, newer than this store's ${LAYOUT}`,
		);
	}
}
