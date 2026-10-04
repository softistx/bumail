import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import { directoryFile } from './database';
import { Directory } from './directory';
import {
	freshDirectory,
	PASSWORD,
	seededDirectory,
} from './directory.fixtures';
import { MIGRATIONS } from './schema';

const opened: Directory[] = [];
afterEach(() => {
	for (const directory of opened.splice(0)) directory.close();
});

function keep(directory: Directory): Directory {
	opened.push(directory);
	return directory;
}

/** The `ServerError` `fn` throws, as `CODE: message`. */
async function failure(fn: () => unknown): Promise<string> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof ServerError) return `${error.code}: ${error.message}`;
		throw error;
	}
	throw new Error('it did not throw');
}

describe('the file', () => {
	test('is created private, in WAL mode, at the last schema version', () => {
		const file = join(tempDir(), 'sub', 'directory.sqlite');
		keep(Directory.open({ file }));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const db = new Database(file, { readonly: true });
		try {
			expect(
				db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
					?.journal_mode,
			).toBe('wal');
			expect(
				db.query<{ version: number }, []>('SELECT version FROM schema').all(),
			).toEqual([{ version: MIGRATIONS.length }]);
		} finally {
			db.close();
		}
	});

	test('opens again as it was', async () => {
		const file = join(tempDir(), 'directory.sqlite');
		const first = Directory.open({ file });
		first.domains.add('example.com');
		first.close();
		const again = keep(Directory.open({ file }));
		expect(again.domains.list().map(({ name }) => name)).toEqual([
			'example.com',
		]);
	});

	test('is refused when a newer server wrote it', async () => {
		const file = join(tempDir(), 'directory.sqlite');
		Directory.open({ file }).close();
		const db = new Database(file);
		db.exec(`UPDATE schema SET version = ${MIGRATIONS.length + 1}`);
		db.close();
		expect(await failure(() => Directory.open({ file }))).toBe(
			`UNAVAILABLE: the directory is at schema version ${MIGRATIONS.length + 1}, newer than this server's ${MIGRATIONS.length}`,
		);
	});

	test('that cannot be made is UNAVAILABLE, naming it', async () => {
		const dir = tempDir();
		await Bun.write(join(dir, 'file'), 'x');
		const file = join(dir, 'file', 'directory.sqlite');
		expect(await failure(() => Directory.open({ file }))).toStartWith(
			`UNAVAILABLE: the directory ${file} cannot be opened (`,
		);
	});

	test('directoryFile reads a sqlite: URL', () => {
		expect(directoryFile('sqlite:/data/directory.sqlite')).toBe(
			'/data/directory.sqlite',
		);
		expect(directoryFile('sqlite:/data/my%20dir/d.sqlite')).toBe(
			'/data/my dir/d.sqlite',
		);
	});

	test('a change made through one opening is seen by another at once', async () => {
		const file = join(tempDir(), 'directory.sqlite');
		const server = keep(Directory.open({ file }));
		const command = keep(Directory.open({ file }));
		expect(server.resolve('alice@example.com')).toBeUndefined();
		command.domains.add('example.com');
		await command.users.add('alice@example.com', PASSWORD);
		expect(server.resolve('alice@example.com')).toEqual(['alice@example.com']);
		command.users.setDisabled('alice@example.com', true);
		expect(
			await server.authenticate('alice@example.com', PASSWORD, '192.0.2.1'),
		).toEqual({ ok: false, reason: 'disabled' });
	});
});

describe('domains', () => {
	test('are added lowercase, listed with their counts, removed once empty', async () => {
		const directory = keep(await seededDirectory());
		expect(directory.domains.add('Example.ORG.').name).toBe('example.org');
		expect(
			directory.domains
				.list()
				.map(({ name, users, aliases }) => [name, users, aliases]),
		).toEqual([
			['example.com', 2, 1],
			['example.org', 0, 0],
		]);
		expect(directory.domains.has('EXAMPLE.com')).toBe(true);
		expect(directory.domains.has('example.net')).toBe(false);
		expect(directory.domains.has('not a domain')).toBe(false);
		expect(directory.domains.remove('example.org')).toBe('example.org');
		expect(directory.domains.get('example.org')).toBeUndefined();
	});

	test('refuse a duplicate, a bad name, an unknown one, and one in use', async () => {
		const directory = keep(await seededDirectory());
		expect(await failure(() => directory.domains.add('EXAMPLE.com'))).toBe(
			'ALREADY_EXISTS: the domain example.com already exists',
		);
		expect(await failure(() => directory.domains.add('localhost'))).toBe(
			'INVALID: "localhost" is not a domain name',
		);
		expect(await failure(() => directory.domains.remove('example.net'))).toBe(
			'NOT_FOUND: the domain example.net does not exist',
		);
		expect(await failure(() => directory.domains.remove('example.com'))).toBe(
			'IN_USE: the domain example.com still has 2 users and 1 alias; remove them first',
		);
		directory.aliases.remove('sales@example.com');
		directory.users.remove('bob@example.com');
		expect(await failure(() => directory.domains.remove('example.com'))).toBe(
			'IN_USE: the domain example.com still has 1 user; remove them first',
		);
	});
});

describe('users', () => {
	test('are kept lowercase, with an argon2id hash, never the password', async () => {
		const directory = keep(freshDirectory());
		directory.domains.add('example.com');
		const user = await directory.users.add('Alice@Example.com', PASSWORD);
		expect(user).toMatchObject({
			address: 'alice@example.com',
			domain: 'example.com',
			disabled: false,
		});
		const record = directory.users.record('ALICE@example.com');
		expect(record?.hash).toStartWith('$argon2id$v=19$m=19456,t=2,');
		expect(record?.hash).not.toContain(PASSWORD);
		expect(directory.users.get('alice@EXAMPLE.COM')?.address).toBe(
			'alice@example.com',
		);
	});

	test('are listed, all or by domain', async () => {
		const directory = keep(await seededDirectory());
		directory.domains.add('example.org');
		await directory.users.add('carol@example.org', PASSWORD);
		expect(directory.users.list().map(({ address }) => address)).toEqual([
			'alice@example.com',
			'bob@example.com',
			'carol@example.org',
		]);
		expect(
			directory.users.list('Example.ORG').map(({ address }) => address),
		).toEqual(['carol@example.org']);
	});

	test('refuse an unknown domain, a duplicate in any case, an alias, a bad address', async () => {
		const directory = keep(await seededDirectory());
		expect(
			await failure(() => directory.users.add('carol@example.net', PASSWORD)),
		).toBe(
			'NOT_FOUND: the domain example.net is not hosted here; add it first',
		);
		expect(
			await failure(() => directory.users.add('ALICE@example.com', PASSWORD)),
		).toBe('ALREADY_EXISTS: the user alice@example.com already exists');
		expect(
			await failure(() => directory.users.add('Sales@example.com', PASSWORD)),
		).toBe(
			'ALREADY_EXISTS: sales@example.com is an alias; a user cannot take its address',
		);
		expect(await failure(() => directory.users.add('carol', PASSWORD))).toBe(
			'INVALID: "carol" is not an e-mail address',
		);
	});

	test('refuse a password too short, too long, or with a control character, never repeating it', async () => {
		const directory = keep(await seededDirectory());
		const cases: [string, string][] = [
			['short-pw-11', 'the password must be at least 12 characters'],
			['é'.repeat(11), 'the password must be at least 12 characters'],
			['x'.repeat(1025), 'the password must be at most 1024 bytes'],
			[
				'line break pw\n',
				'the password must not hold a control character, such as a line break',
			],
		];
		for (const [password, message] of cases) {
			const found = await failure(() =>
				directory.users.add('carol@example.com', password),
			);
			expect(found).toBe(`INVALID: ${message}`);
			expect(found).not.toContain(password.trim());
		}
		expect(
			(await directory.users.add('carol@example.com', 'é'.repeat(12))).address,
		).toBe('carol@example.com');
	});

	test('change password, disable and enable', async () => {
		const directory = keep(await seededDirectory());
		await directory.users.setPassword(
			'alice@example.com',
			'another long password',
		);
		expect(
			(await directory.authenticate('alice@example.com', PASSWORD, '192.0.2.1'))
				.ok,
		).toBe(false);
		expect(
			(
				await directory.authenticate(
					'alice@example.com',
					'another long password',
					'192.0.2.1',
				)
			).ok,
		).toBe(true);
		expect(
			directory.users.setDisabled('alice@example.com', true).disabled,
		).toBe(true);
		expect(
			directory.users.setDisabled('alice@example.com', false).disabled,
		).toBe(false);
		expect(
			await failure(() =>
				directory.users.setDisabled('nobody@example.com', true),
			),
		).toBe('NOT_FOUND: the user nobody@example.com does not exist');
		expect(
			await failure(() =>
				directory.users.setPassword('nobody@example.com', PASSWORD),
			),
		).toBe('NOT_FOUND: the user nobody@example.com does not exist');
	});

	test('are removed only once no alias points to them', async () => {
		const directory = keep(await seededDirectory());
		directory.aliases.add('team@example.com', ['alice@example.com']);
		expect(
			await failure(() => directory.users.remove('alice@example.com')),
		).toBe(
			'IN_USE: alice@example.com is a target of sales@example.com, team@example.com; remove those aliases first',
		);
		directory.aliases.remove('team@example.com');
		expect(
			await failure(() => directory.users.remove('alice@example.com')),
		).toBe(
			'IN_USE: alice@example.com is a target of sales@example.com; remove that alias first',
		);
		directory.aliases.remove('sales@example.com');
		expect(directory.users.remove('Alice@example.com').address).toBe(
			'alice@example.com',
		);
		expect(directory.users.get('alice@example.com')).toBeUndefined();
		expect(
			await failure(() => directory.users.remove('alice@example.com')),
		).toBe('NOT_FOUND: the user alice@example.com does not exist');
	});
});

describe('aliases', () => {
	test('point to local users, deduplicated, in any case', async () => {
		const directory = keep(await seededDirectory());
		const alias = directory.aliases.add('Team@Example.com', [
			'BOB@example.com',
			'alice@example.com',
			'bob@example.com',
		]);
		expect(alias).toMatchObject({
			address: 'team@example.com',
			domain: 'example.com',
			targets: ['alice@example.com', 'bob@example.com'],
		});
		expect(directory.aliases.list().map(({ address }) => address)).toEqual([
			'sales@example.com',
			'team@example.com',
		]);
		expect(directory.aliases.list('example.org')).toEqual([]);
	});

	test('never point elsewhere: no forwarding, which would make the server a relay', async () => {
		const directory = keep(await seededDirectory());
		directory.domains.add('example.org');
		for (const target of [
			'someone@example.net',
			'nobody@example.com',
			'nobody@example.org',
			'sales@example.com',
		]) {
			expect(
				await failure(() =>
					directory.aliases.add('team@example.com', [target]),
				),
			).toBe(
				`INVALID: ${target} is not a user here: an alias points to local users only, never elsewhere`,
			);
		}
		expect(directory.aliases.get('team@example.com')).toBeUndefined();
	});

	test('refuse no target, a user’s address, a duplicate, an unknown domain', async () => {
		const directory = keep(await seededDirectory());
		expect(
			await failure(() => directory.aliases.add('team@example.com', [])),
		).toBe('INVALID: an alias needs at least one target');
		expect(
			await failure(() =>
				directory.aliases.add('Alice@example.com', ['bob@example.com']),
			),
		).toBe(
			'ALREADY_EXISTS: alice@example.com is a user; an alias cannot take its address',
		);
		expect(
			await failure(() =>
				directory.aliases.add('sales@example.com', ['bob@example.com']),
			),
		).toBe('ALREADY_EXISTS: the alias sales@example.com already exists');
		expect(
			await failure(() =>
				directory.aliases.add('team@example.net', ['bob@example.com']),
			),
		).toBe(
			'NOT_FOUND: the domain example.net is not hosted here; add it first',
		);
		expect(
			await failure(() => directory.aliases.remove('team@example.com')),
		).toBe('NOT_FOUND: the alias team@example.com does not exist');
	});
});

describe('resolve', () => {
	test('answers a user, an alias’s users, or undefined', async () => {
		const directory = keep(await seededDirectory());
		expect(directory.resolve('Alice@EXAMPLE.com')).toEqual([
			'alice@example.com',
		]);
		expect(directory.resolve('sales@example.com')).toEqual([
			'alice@example.com',
			'bob@example.com',
		]);
		expect(directory.resolve('nobody@example.com')).toBeUndefined();
		expect(directory.resolve('alice@example.net')).toBeUndefined();
		expect(directory.resolve('not an address')).toBeUndefined();
	});

	test('still delivers to a disabled user', async () => {
		const directory = keep(await seededDirectory());
		directory.users.setDisabled('alice@example.com', true);
		expect(directory.resolve('alice@example.com')).toEqual([
			'alice@example.com',
		]);
	});
});
