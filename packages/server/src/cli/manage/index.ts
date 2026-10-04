import type { ServerConfig } from '../../config/types';
import { directoryFile } from '../../directory/database';
import { Directory } from '../../directory/directory';
import type { ManageArgs } from '../verbs';
import { alias } from './alias';
import { dkim } from './dkim';
import { domain } from './domain';
import type { Handler, ManageIo } from './shared';
import { user } from './user';

export type { ManageIo } from './shared';

const commands: Record<ManageArgs['noun'], Handler> = {
	domain,
	user,
	alias,
	dkim,
};

/**
 * Runs `bumail domain|user|alias|dkim …` against the directory `config`
 * names, and, for `user add` and `user remove --purge`, its mail store.
 */
export async function manage(
	args: ManageArgs,
	config: ServerConfig,
	io: ManageIo,
): Promise<void> {
	const directory = Directory.open({
		file: directoryFile(config.directory.url),
	});
	try {
		await commands[args.noun](args, directory, config, io);
	} finally {
		directory.close();
	}
}
