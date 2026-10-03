import type { Cursor } from '../protocol/cursor';
import { type Piece, tagged } from '../protocol/response';
import type { Connection, Phase } from '../server/connection';

/** What a command handler is given. */
export interface Context {
	readonly connection: Connection;
	readonly tag: string;
	/** The command's arguments, after its name and the space that follows it. */
	readonly cursor: Cursor;
	/** The command came as `UID <name>`. */
	readonly uid: boolean;
	/** Its name, upper case, without `UID`. */
	readonly name: string;
}

export interface Command {
	/** The states it is valid in (RFC 9051 §6). */
	readonly phases: readonly Phase[];
	/** Whether it takes no argument: then nothing may follow its name. */
	readonly bare?: boolean;
	run(context: Context): Promise<void>;
}

export const ANY: readonly Phase[] = [
	'not-authenticated',
	'authenticated',
	'selected',
];
export const NOT_AUTHENTICATED: readonly Phase[] = ['not-authenticated'];
export const AUTHENTICATED: readonly Phase[] = ['authenticated', 'selected'];
export const SELECTED: readonly Phase[] = ['selected'];

export function ok(context: Context, text: string): Promise<void> {
	return context.connection.send(tagged(context.tag, 'OK', text));
}

export function no(context: Context, text: string): Promise<void> {
	return context.connection.send(tagged(context.tag, 'NO', text));
}

export function bad(context: Context, text: string): Promise<void> {
	return context.connection.send(tagged(context.tag, 'BAD', text));
}

export function send(
	context: Context,
	pieces: readonly Piece[],
): Promise<void> {
	return context.connection.send(pieces);
}
