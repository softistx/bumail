import type { ServerConfig } from '../../config/types';
import { checkAddress } from '../../directory/address';
import type { Directory } from '../../directory/directory';
import { ServerError } from '../../errors';
import { provisionAccount, purgeAccount } from '../../store/accounts';
import { isHeld, storeFailure } from '../../store/open';
import { readPassword } from '../secret';
import { type Handler, table, withStore } from './shared';

/** `bumail user add|passwd|disable|enable|remove|list`, its mailboxes in the store with it. */
export const user: Handler = async (args, directory, config, io) => {
	const { verb, operands } = args;
	const [address = ''] = operands;
	const { out } = io;
	if (verb === 'list') {
		out(
			table(
				directory.users
					.list(operands[0])
					.map((user) => [user.address, user.disabled ? 'disabled' : '']),
			),
		);
	} else if (verb === 'add' || verb === 'passwd') {
		// The address is checked before a password is asked for.
		const key =
			verb === 'add'
				? directory.users.checkAddable(address)
				: directory.users.require(address).address;
		const password = await readPassword(
			args.password ?? { from: 'prompt' },
			io.terminal,
			key,
		);
		if (verb === 'passwd') {
			await directory.users.setPassword(key, password);
			out(`changed the password of ${key}\n`);
			return;
		}
		const user = await directory.users.add(key, password);
		await addMailboxes(user.address, config, out);
	} else if (verb === 'disable' || verb === 'enable') {
		const user = directory.users.setDisabled(address, verb === 'disable');
		out(`${verb}d the user ${user.address}\n`);
	} else {
		await removeUser(address, args.purge === true, directory, config, out);
	}
};

/**
 * Removes a user; with `purge`, its account and mail in the store too.
 * The user is disabled first, so no new login creates the account again
 * while it goes; the mail next, so should the store fail, the user is
 * still there, disabled, and the command can run again; the user last.
 * A login verified before the disable may still create an empty account
 * after the purge: with the user gone, `--purge` again deletes that
 * account alone, so nothing is left behind.
 */
async function removeUser(
	address: string,
	purge: boolean,
	directory: Directory,
	config: ServerConfig,
	out: (text: string) => void,
): Promise<void> {
	if (!purge) {
		const user = directory.users.remove(address);
		out(
			`removed the user ${user.address}; its mail is kept in the store (bumail user remove --purge deletes it)\n`,
		);
		return;
	}
	const key = checkAddress(address).address;
	if (directory.users.get(key) === undefined) {
		await purgeLeftover(key, config, out);
		return;
	}
	const user = directory.users.checkRemovable(key);
	await withStore(config, async ({ store }) => {
		directory.users.setDisabled(user.address, true);
		try {
			await purgeAccount(store, user.address);
		} catch (error) {
			const reason = storeFailure(error, config.store).message;
			throw new ServerError(
				'UNAVAILABLE',
				`the user ${user.address} is disabled, but its mail is not purged: ${reason}; run the command again`,
			);
		}
		directory.users.remove(user.address);
	});
	out(`removed the user ${user.address} and its mail\n`);
}

/**
 * Deletes the store account of an address that is no longer a user: one
 * removed without `--purge`, or re-created empty by a login under way
 * during a purge. `NOT_FOUND` when the store has none either.
 */
async function purgeLeftover(
	address: string,
	config: ServerConfig,
	out: (text: string) => void,
): Promise<void> {
	const purged = await withStore(config, ({ store }) =>
		purgeAccount(store, address),
	);
	if (!purged) {
		throw new ServerError('NOT_FOUND', `the user ${address} does not exist`);
	}
	out(
		`${address} is not a user; deleted its account and mail left in the mail store\n`,
	);
}

/**
 * Creates the new user's account in the mail store, with its mailboxes.
 * A SQLite store the running server holds cannot be opened here: the
 * server creates them at the first login instead.
 */
async function addMailboxes(
	address: string,
	config: ServerConfig,
	out: (text: string) => void,
): Promise<void> {
	try {
		await withStore(config, ({ store }) => provisionAccount(store, address));
	} catch (error) {
		if (!isHeld(error)) {
			const reason =
				error instanceof ServerError ? error.message : String(error);
			throw new ServerError(
				'UNAVAILABLE',
				`added the user ${address}, but not its mailboxes: ${reason}; the server creates them at its first login`,
			);
		}
		out(
			`added the user ${address}; the mail store is in use by the running server, which creates its mailboxes at its first login\n`,
		);
		return;
	}
	out(`added the user ${address}, with its mailboxes\n`);
}
