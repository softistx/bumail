import type { ServerConfig } from '../config/types';
import { checkAddress, checkDomain } from '../directory/address';
import { directoryFile } from '../directory/database';
import { Directory } from '../directory/directory';
import { DKIM_KEY_BITS, zoneLine } from '../directory/dkim';
import { ServerError } from '../errors';
import { provisionAccount, purgeAccount } from '../store/accounts';
import {
	isHeld,
	type OpenedStore,
	openStore,
	storeFailure,
} from '../store/open';
import { readPassword, type Terminal } from './secret';
import type { ManageArgs } from './verbs';

type Manage = ManageArgs;

/** Where a directory command writes, and what it reads. */
export interface ManageIo {
	readonly out: (text: string) => void;
	readonly terminal: Terminal;
}

/** `rows` as lines, the first column padded to the widest. */
function table(rows: readonly (readonly [string, string])[]): string {
	const width = Math.max(0, ...rows.map(([first]) => first.length));
	return rows
		.map(([first, second]) =>
			second === '' ? `${first}\n` : `${first.padEnd(width)}  ${second}\n`,
		)
		.join('');
}

function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Runs `fn` with the store open, closing it after; failures as `UNAVAILABLE`. */
async function withStore<T>(
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

/**
 * Runs `bumail domain|user|alias …` against the directory `config`
 * names, and, for `user add` and `user remove --purge`, its mail store.
 */
export async function manage(
	args: Manage,
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

type Handler = (
	args: Manage,
	directory: Directory,
	config: ServerConfig,
	io: ManageIo,
) => Promise<void>;

const commands: Record<Manage['noun'], Handler> = {
	async domain({ verb, operands }, directory, _, { out }) {
		const [name = ''] = operands;
		if (verb === 'add') {
			out(`added the domain ${directory.domains.add(name).name}\n`);
		} else if (verb === 'remove') {
			out(`removed the domain ${directory.domains.remove(name)}\n`);
		} else {
			out(
				table(
					directory.domains
						.list()
						.map((domain) => [
							domain.name,
							`${count(domain.users, 'user', 'users')}, ${count(domain.aliases, 'alias', 'aliases')}`,
						]),
				),
			);
		}
	},

	async user(args, directory, config, io) {
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
	},

	async dkim(args, directory, _, { out }) {
		const [domain = ''] = args.operands;
		if (args.verb === 'list') {
			out(
				table(
					directory.dkim
						.list()
						.map((key) => [key.domain, `selector ${key.selector}`]),
				),
			);
			return;
		}
		if (args.verb === 'remove') {
			out(
				`removed the DKIM key of ${directory.dkim.remove(domain)}; its mail goes unsigned\n`,
			);
			return;
		}
		const key =
			args.verb === 'generate'
				? await directory.dkim.generate(domain, {
						...(args.selector === undefined ? {} : { selector: args.selector }),
						replace: args.replace,
					})
				: directory.dkim.get(domain);
		if (key === undefined) {
			throw new ServerError(
				'NOT_FOUND',
				`the domain ${checkDomain(domain)} has no DKIM key; bumail dkim generate makes one`,
			);
		}
		if (args.verb === 'generate') {
			out(
				`generated an RSA-${DKIM_KEY_BITS} DKIM key for ${key.domain}, selector ${key.selector}; mail from ${key.domain} is signed with it from now on\n`,
			);
		}
		out(
			[
				'publish this TXT record:',
				`  name   ${key.name}`,
				`  value  ${key.record}`,
				'as a zone file line:',
				`  ${zoneLine(key)}`,
				'',
			].join('\n'),
		);
	},

	async alias({ verb, operands }, directory, _, { out }) {
		const [address = '', ...targets] = operands;
		if (verb === 'add') {
			const alias = directory.aliases.add(address, targets);
			out(`added the alias ${alias.address}: ${alias.targets.join(', ')}\n`);
		} else if (verb === 'remove') {
			out(`removed the alias ${directory.aliases.remove(address).address}\n`);
		} else {
			out(
				table(
					directory.aliases
						.list(operands[0])
						.map((alias) => [alias.address, alias.targets.join(', ')]),
				),
			);
		}
	},
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
