import { join } from 'node:path';
import { tempDir } from '../config/config.fixtures';
import { Directory, type DirectoryOptions } from './directory';

/** A password the directory takes. */
export const PASSWORD = 'correct horse battery staple';

/** A directory in a fresh file, closed after the spec by the caller. */
export function freshDirectory(
	options: Omit<DirectoryOptions, 'file'> = {},
): Directory {
	return Directory.open({
		file: join(tempDir(), 'directory.sqlite'),
		...options,
	});
}

/** A directory hosting example.com, with alice and bob, and sales@ to both. */
export async function seededDirectory(
	options: Omit<DirectoryOptions, 'file'> = {},
): Promise<Directory> {
	const directory = freshDirectory(options);
	directory.domains.add('example.com');
	await directory.users.add('alice@example.com', PASSWORD);
	await directory.users.add('bob@example.com', PASSWORD);
	directory.aliases.add('sales@example.com', [
		'alice@example.com',
		'bob@example.com',
	]);
	return directory;
}
