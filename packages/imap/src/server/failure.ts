import { SyntaxProblem } from '../protocol/cursor';
import { echo } from '../protocol/echo';
import { tagged } from '../protocol/response';
import type { Connection } from './connection';

/** A store's refusal, told by its name and code: a second copy of the store package would fail `instanceof`. */
function storeCode(error: unknown): string | undefined {
	if (error instanceof Error && error.name === 'StoreError') {
		const code = (error as { code?: unknown }).code;
		return typeof code === 'string' ? code : undefined;
	}
	return undefined;
}

/** The tagged answer to a command that threw. */
export async function answerFailure(
	connection: Connection,
	tag: string,
	error: unknown,
): Promise<void> {
	if (error instanceof SyntaxProblem) {
		return connection.send(tagged(tag, 'BAD', error.message));
	}
	// A store's message may repeat the client's mailbox name: never raw, never long.
	const message = echo(
		error instanceof Error ? error.message : String(error),
		200,
	);
	switch (storeCode(error)) {
		case 'NOT_FOUND':
			return connection.send(tagged(tag, 'NO', `[NONEXISTENT] ${message}`));
		case 'ALREADY_EXISTS':
			return connection.send(tagged(tag, 'NO', `[ALREADYEXISTS] ${message}`));
		case 'INVALID':
			return connection.send(tagged(tag, 'NO', `[CANNOT] ${message}`));
		default:
			connection.report(error);
			return connection.send(tagged(tag, 'NO', '[SERVERBUG] Internal error'));
	}
}
