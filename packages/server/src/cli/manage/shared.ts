import type { ServerConfig } from '../../config/types';
import type { Directory } from '../../directory/directory';
import { type OpenedStore, openStore, storeFailure } from '../../store/open';
import type { Terminal } from '../secret';
import type { ManageArgs } from '../verbs';

/** Where a directory command writes, and what it reads. */
export interface ManageIo {
	readonly out: (text: string) => void;
	readonly terminal: Terminal;
}

/** One noun's commands: `bumail domain …`, `user …`, `alias …`, `dkim …`. */
export type Handler = (
	args: ManageArgs,
	directory: Directory,
	config: ServerConfig,
	io: ManageIo,
) => Promise<void>;

/** `rows` as lines, the first column padded to the widest. */
export function table(rows: readonly (readonly [string, string])[]): string {
	const width = Math.max(0, ...rows.map(([first]) => first.length));
	return rows
		.map(([first, second]) =>
			second === '' ? `${first}\n` : `${first.padEnd(width)}  ${second}\n`,
		)
		.join('');
}

export function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Runs `fn` with the store open, closing it after; failures as `UNAVAILABLE`. */
export async function withStore<T>(
	config: ServerConfig,
	fn: (opened: OpenedStore) => Promise<T>,
): Promise<T> {
	const opened = openStore(config.store);
	try {
		return await fn(opened);
	} catch (error) {
		throw storeFailure(error, config.store);
	} finally {
		await opened.close();
	}
}
