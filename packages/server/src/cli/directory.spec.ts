import { describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteMailStore } from '@bumail/store/sqlite';
import { ACME, tempDir } from '../config/config.fixtures';
import { readConfig } from '../config/read';
import { Directory } from '../directory/directory';
import { ServerError } from '../errors';
import { provisionAccount } from '../store/accounts';
import { parseArgs } from './args';
import { manage } from './manage';

const MAIN = join(import.meta.dir, '..', 'main.ts');
const SECRET = 'correct horse battery staple';

interface Ran {
	code: number;
	out: string;
	err: string;
}

/** A configuration in a fresh data directory; `bumail` runs against it. */
function server() {
	const data = tempDir();
	const config = join(data, 'bumail.toml');
	writeFileSync(
		config,
		`hostname = "mail.example.com"\ndata = "${data}"\n${ACME}`,
	);
	const seen: string[] = [];
	return {
		data,
		config,
		/** Every byte `bumail` wrote, for the check that no password is among them. */
		seen,
		async bumail(args: readonly string[], stdin?: string): Promise<Ran> {
			const proc = Bun.spawn(
				[process.execPath, MAIN, '--config', config, ...args],
				{
					env: { PATH: process.env['PATH'] ?? '' },
					stdin:
						stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			seen.push(out, err);
			return { code, out, err };
		},
		directory: () => Directory.open({ file: join(data, 'directory.sqlite') }),
		store: () => SqliteMailStore.open({ directory: join(data, 'mail') }),
	};
}

async function seeded() {
	const it = server();
	expect((await it.bumail(['domain', 'add', 'example.com'])).code).toBe(0);
	for (const user of ['alice@example.com', 'bob@example.com']) {
		expect(
			(
				await it.bumail(
					['user', 'add', user, '--password-stdin'],
					`${SECRET}\n`,
				)
			).code,
		).toBe(0);
	}
	return it;
}

describe('bumail domain', () => {
	test('add, list and remove', async () => {
		const { bumail } = server();
		expect(await bumail(['domain', 'add', 'Example.COM'])).toEqual({
			code: 0,
			out: 'added the domain example.com\n',
			err: '',
		});
		await bumail(['domain', 'add', 'example.org']);
		expect((await bumail(['domain', 'list'])).out).toBe(
			'example.com  0 users, 0 aliases\nexample.org  0 users, 0 aliases\n',
		);
		expect(await bumail(['domain', 'remove', 'example.org'])).toEqual({
			code: 0,
			out: 'removed the domain example.org\n',
			err: '',
		});
		expect((await bumail(['domain', 'list'])).out).toBe(
			'example.com  0 users, 0 aliases\n',
		);
	});

	test('refusals exit 4', async () => {
		const { bumail } = await seeded();
		expect(await bumail(['domain', 'add', 'example.com'])).toEqual({
			code: 4,
			out: '',
			err: 'bumail: the domain example.com already exists\n',
		});
		expect((await bumail(['domain', 'add', 'localhost'])).err).toBe(
			'bumail: the value given is not a domain name\n',
		);
		expect(await bumail(['domain', 'remove', 'example.com'])).toEqual({
			code: 4,
			out: '',
			err: 'bumail: the domain example.com still has 2 users; remove them first\n',
		});
		expect((await bumail(['domain', 'remove', 'example.net'])).err).toBe(
			'bumail: the domain example.net does not exist\n',
		);
	});
});

describe('bumail user', () => {
	test('add reads the password from stdin, and creates the mailboxes in the store', async () => {
		const it = server();
		await it.bumail(['domain', 'add', 'example.com']);
		expect(
			await it.bumail(
				['user', 'add', 'Alice@example.com', '--password-stdin'],
				`${SECRET}\n`,
			),
		).toEqual({
			code: 0,
			out: 'added the user alice@example.com, with its mailboxes\n',
			err: '',
		});
		const store = it.store();
		try {
			const account = await store.findAccount('alice@example.com');
			expect(account?.name).toBe('alice@example.com');
			expect(await store.findMailbox(account?.id ?? '', 'inbox')).toBeDefined();
			expect(await store.findMailbox(account?.id ?? '', 'junk')).toBeDefined();
		} finally {
			store.close();
		}
		const directory = it.directory();
		try {
			expect(
				(await directory.authenticate('alice@example.com', SECRET, '192.0.2.1'))
					.ok,
			).toBe(true);
		} finally {
			directory.close();
		}
	});

	test('add reads the password from a file, one final line break dropped', async () => {
		const it = server();
		await it.bumail(['domain', 'add', 'example.com']);
		const file = join(it.data, 'secret');
		writeFileSync(file, `${SECRET}\r\n`);
		expect(
			(
				await it.bumail([
					'user',
					'add',
					'carol@example.com',
					`--password-file=${file}`,
				])
			).code,
		).toBe(0);
		const directory = it.directory();
		try {
			expect(
				(await directory.authenticate('carol@example.com', SECRET, '192.0.2.1'))
					.ok,
			).toBe(true);
		} finally {
			directory.close();
		}
		expect(
			await it.bumail([
				'user',
				'add',
				'dave@example.com',
				'--password-file',
				join(it.data, 'missing'),
			]),
		).toEqual({
			code: 4,
			out: '',
			err: 'bumail: --password-file: cannot be read (ENOENT)\n',
		});
	});

	test('add without a terminal or an option is bad usage, checked after the address', async () => {
		const it = await seeded();
		expect(await it.bumail(['user', 'add', 'carol@example.com'])).toEqual({
			code: 2,
			out: '',
			err: 'bumail: standard input is not a terminal, so no password can be typed: give --password-stdin or --password-file; see bumail --help\n',
		});
		expect((await it.bumail(['user', 'add', 'alice@example.com'])).err).toBe(
			'bumail: the user alice@example.com already exists\n',
		);
	});

	test('add says so when the running server holds the store, and the user can still log in', async () => {
		const it = server();
		await it.bumail(['domain', 'add', 'example.com']);
		const store = it.store();
		try {
			expect(
				await it.bumail(
					['user', 'add', 'alice@example.com', '--password-stdin'],
					SECRET,
				),
			).toEqual({
				code: 0,
				out: 'added the user alice@example.com; the mail store is in use by the running server, which creates its mailboxes at its first login\n',
				err: '',
			});
			expect(await store.findAccount('alice@example.com')).toBeUndefined();
			expect(
				await it.bumail(['user', 'remove', 'alice@example.com', '--purge']),
			).toEqual({
				code: 5,
				out: '',
				err: 'bumail: the mail store is in use by another process, such as the running server\n',
			});
		} finally {
			store.close();
		}
		expect((await it.bumail(['user', 'list'])).out).toBe('alice@example.com\n');
	});

	test('list, passwd, disable and enable', async () => {
		const it = await seeded();
		await it.bumail(['domain', 'add', 'example.org']);
		await it.bumail(
			['user', 'add', 'carol@example.org', '--password-stdin'],
			SECRET,
		);
		expect(await it.bumail(['user', 'disable', 'Bob@example.com'])).toEqual({
			code: 0,
			out: 'disabled the user bob@example.com\n',
			err: '',
		});
		expect((await it.bumail(['user', 'list'])).out).toBe(
			'alice@example.com\nbob@example.com    disabled\ncarol@example.org\n',
		);
		expect((await it.bumail(['user', 'list', 'example.org'])).out).toBe(
			'carol@example.org\n',
		);
		expect((await it.bumail(['user', 'enable', 'bob@example.com'])).out).toBe(
			'enabled the user bob@example.com\n',
		);
		const fresh = 'a brand new passphrase';
		expect(
			await it.bumail(
				['user', 'passwd', 'alice@example.com', '--password-stdin'],
				fresh,
			),
		).toEqual({
			code: 0,
			out: 'changed the password of alice@example.com\n',
			err: '',
		});
		const directory = it.directory();
		try {
			expect(
				(await directory.authenticate('alice@example.com', fresh, '192.0.2.1'))
					.ok,
			).toBe(true);
			expect(
				(await directory.authenticate('bob@example.com', SECRET, '192.0.2.1'))
					.ok,
			).toBe(true);
		} finally {
			directory.close();
		}
		expect(
			await it.bumail(
				['user', 'passwd', 'nobody@example.com', '--password-stdin'],
				fresh,
			),
		).toEqual({
			code: 4,
			out: '',
			err: 'bumail: the user nobody@example.com does not exist\n',
		});
	});

	test('remove keeps the mail; --purge deletes it', async () => {
		const it = await seeded();
		expect(await it.bumail(['user', 'remove', 'alice@example.com'])).toEqual({
			code: 0,
			out: 'removed the user alice@example.com; its mail is kept in the store (bumail user remove --purge deletes it)\n',
			err: '',
		});
		expect(
			await it.bumail(['user', 'remove', 'bob@example.com', '--purge']),
		).toEqual({
			code: 0,
			out: 'removed the user bob@example.com and its mail\n',
			err: '',
		});
		const store = it.store();
		try {
			expect(await store.findAccount('alice@example.com')).toBeDefined();
			expect(await store.findAccount('bob@example.com')).toBeUndefined();
		} finally {
			store.close();
		}
		expect((await it.bumail(['user', 'list'])).out).toBe('');
		expect((await it.bumail(['user', 'remove', 'bob@example.com'])).code).toBe(
			4,
		);
	});
});

describe('bumail user remove --purge, when the store fails', () => {
	test('leaves the user, disabled, and says to run it again', async () => {
		const it = await seeded();
		const deleteAccount = spyOn(
			SqliteMailStore.prototype,
			'deleteAccount',
		).mockImplementation(() => Promise.reject(new Error('disk full')));
		const lines: string[] = [];
		try {
			const config = await readConfig({ path: it.config, env: {} });
			const args = parseArgs([
				'user',
				'remove',
				'alice@example.com',
				'--purge',
			]);
			if (args.kind !== 'manage') throw new Error('not a manage command');
			const failed = await manage(args, config, {
				out: (text) => lines.push(text),
				terminal: {
					stdin: async () => '',
					isTTY: false,
					prompt: async () => '',
				},
			}).catch((error: unknown) => error);
			expect(deleteAccount).toHaveBeenCalled();
			expect(failed).toBeInstanceOf(ServerError);
			expect((failed as ServerError).code).toBe('UNAVAILABLE');
			expect((failed as ServerError).message).toBe(
				'the user alice@example.com is disabled, but its mail is not purged: the mail store failed (disk full); run the command again',
			);
		} finally {
			deleteAccount.mockRestore();
		}
		expect(lines).toEqual([]);
		const directory = it.directory();
		try {
			expect(directory.users.get('alice@example.com')).toMatchObject({
				disabled: true,
			});
		} finally {
			directory.close();
		}
	});
});

describe('bumail user remove --purge, with the user gone', () => {
	test('deletes an account left in the store, then says the user does not exist', async () => {
		const it = await seeded();
		expect(
			(await it.bumail(['user', 'remove', 'bob@example.com', '--purge'])).code,
		).toBe(0);
		// A login verified before the disable re-creates an empty account.
		const store = it.store();
		try {
			await provisionAccount(store, 'bob@example.com');
		} finally {
			store.close();
		}
		expect(
			await it.bumail(['user', 'remove', 'Bob@example.com', '--purge']),
		).toEqual({
			code: 0,
			out: 'bob@example.com is not a user; deleted its account and mail left in the mail store\n',
			err: '',
		});
		const after = it.store();
		try {
			expect(await after.findAccount('bob@example.com')).toBeUndefined();
		} finally {
			after.close();
		}
		const missing = {
			code: 4,
			out: '',
			err: 'bumail: the user bob@example.com does not exist\n',
		};
		expect(
			await it.bumail(['user', 'remove', 'bob@example.com', '--purge']),
		).toEqual(missing);
		expect(await it.bumail(['user', 'remove', 'bob@example.com'])).toEqual(
			missing,
		);
	});

	test('deletes the mail a plain remove kept', async () => {
		const it = await seeded();
		expect(
			(await it.bumail(['user', 'remove', 'alice@example.com'])).code,
		).toBe(0);
		expect(
			(await it.bumail(['user', 'remove', 'alice@example.com', '--purge']))
				.code,
		).toBe(0);
		const store = it.store();
		try {
			expect(await store.findAccount('alice@example.com')).toBeUndefined();
		} finally {
			store.close();
		}
	});
});

describe('an address whose lowercase NFC decomposes', () => {
	test('adds, logs in, removes and purges with the spelling it was added with', async () => {
		const it = await seeded();
		const spelling = 'T\u0308om@example.com';
		const kept = '\u1e97om@example.com';
		expect(
			await it.bumail(
				['user', 'add', spelling, '--password-stdin'],
				`${SECRET}\n`,
			),
		).toMatchObject({ code: 0 });
		const directory = it.directory();
		try {
			expect(
				(await directory.authenticate(spelling, SECRET, '192.0.2.1')).ok,
			).toBe(true);
		} finally {
			directory.close();
		}
		expect(await it.bumail(['user', 'remove', spelling, '--purge'])).toEqual({
			code: 0,
			out: `removed the user ${kept} and its mail\n`,
			err: '',
		});
		const store = it.store();
		try {
			expect(await store.findAccount(kept)).toBeUndefined();
		} finally {
			store.close();
		}
	});
});

describe('bumail alias', () => {
	test('add, list and remove; never to an address elsewhere', async () => {
		const it = await seeded();
		expect(
			await it.bumail([
				'alias',
				'add',
				'Sales@example.com',
				'bob@example.com',
				'alice@example.com',
			]),
		).toEqual({
			code: 0,
			out: 'added the alias sales@example.com: alice@example.com, bob@example.com\n',
			err: '',
		});
		expect(
			await it.bumail([
				'alias',
				'add',
				'fwd@example.com',
				'someone@example.net',
			]),
		).toEqual({
			code: 4,
			out: '',
			err: 'bumail: someone@example.net is not a user here: an alias points to local users only, never elsewhere\n',
		});
		expect((await it.bumail(['alias', 'list'])).out).toBe(
			'sales@example.com  alice@example.com, bob@example.com\n',
		);
		expect((await it.bumail(['user', 'remove', 'bob@example.com'])).err).toBe(
			'bumail: bob@example.com is a target of sales@example.com; remove that alias first\n',
		);
		expect(
			(await it.bumail(['alias', 'remove', 'sales@example.com'])).out,
		).toBe('removed the alias sales@example.com\n');
		expect((await it.bumail(['alias', 'list'])).out).toBe('');
	});
});

describe('bumail dkim', () => {
	test('generate prints the record to publish; show, list and remove', async () => {
		const { bumail, directory } = await seeded();
		const generated = await bumail([
			'dkim',
			'generate',
			'Example.COM',
			'--selector=s1',
		]);
		expect(generated.code).toBe(0);
		const lines = generated.out.split('\n');
		expect(lines[0]).toBe(
			'generated an RSA-2048 DKIM key for example.com, selector s1; mail from example.com is signed with it from now on',
		);
		expect(lines[1]).toBe('publish this TXT record:');
		expect(lines[2]).toBe('  name   s1._domainkey.example.com');
		expect(lines[3]).toMatch(
			/^ {2}value {2}v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]{392}$/,
		);
		expect(lines[5]).toStartWith(
			'  s1._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=',
		);
		expect(generated.out).not.toContain('PRIVATE');
		const opened = directory();
		expect(opened.dkim.get('example.com')?.record).toBe(
			lines[3]?.replace('  value  ', ''),
		);
		opened.close();

		const shown = await bumail(['dkim', 'show', 'example.com']);
		expect(shown.out).toBe(lines.slice(1).join('\n'));
		expect((await bumail(['dkim', 'list'])).out).toBe(
			'example.com  selector s1\n',
		);
		expect(await bumail(['dkim', 'generate', 'example.com'])).toEqual({
			code: 4,
			out: '',
			err: 'bumail: the domain example.com has a DKIM key already; --replace makes a new one\n',
		});
		expect(
			(await bumail(['dkim', 'generate', 'example.com', '--replace'])).out,
		).toContain('selector bumail;');
		expect(await bumail(['dkim', 'remove', 'example.com'])).toEqual({
			code: 0,
			out: 'removed the DKIM key of example.com; its mail goes unsigned\n',
			err: '',
		});
		expect(await bumail(['dkim', 'show', 'example.com'])).toEqual({
			code: 4,
			out: '',
			err: 'bumail: the domain example.com has no DKIM key; bumail dkim generate makes one\n',
		});
	});
});

describe('the usage of the directory commands', () => {
	test.each([
		[['domain'], 'domain needs a command: add, list or remove'],
		[
			['domain', 'rename', 'x'],
			'unknown command domain rename; domain takes add, list or remove',
		],
		[['domain', 'add'], 'domain add takes one domain'],
		[['domain', 'list', 'x'], 'domain list takes nothing'],
		[
			['alias', 'add', 'a@example.com'],
			'alias add takes an address, then one or more users',
		],
		[
			['user', 'disable', 'a@example.com', '--purge'],
			'user disable takes no --purge',
		],
		[
			['user', 'list', '--password-stdin'],
			'user list takes no --password-stdin',
		],
		[
			[
				'user',
				'add',
				'a@example.com',
				'--password-stdin',
				'--password-file',
				'f',
			],
			'--password-stdin and --password-file are both given; give one',
		],
		[
			['user', 'add', 'a@example.com', '--password-file'],
			'--password-file needs a file',
		],
		[['dkim'], 'dkim needs a command: generate, show, list or remove'],
		[['dkim', 'generate'], 'dkim generate takes one domain'],
		[
			['dkim', 'show', 'example.com', '--selector', 's'],
			'dkim show takes no --selector',
		],
		[
			['user', 'remove', 'a@example.com', '--replace'],
			'user remove takes no --replace',
		],
		[
			['dkim', 'generate', 'example.com', '--selector'],
			'--selector needs a selector',
		],
	])('%p exits 2', async (args, message) => {
		const { bumail } = server();
		expect(await bumail(args)).toEqual({
			code: 2,
			out: '',
			err: `bumail: ${message}; see bumail --help\n`,
		});
	});
});

describe('a password', () => {
	test('never reaches the output, whatever goes wrong', async () => {
		const it = await seeded();
		const typed = 'Zq9-unguessable-Secret';
		const cases: [string[], string | undefined][] = [
			[['user', 'add', 'carol@example.com', typed], undefined],
			[['user', 'add', 'carol@example.com', `--password=${typed}`], undefined],
			[['user', 'add', 'carol@example.com', '--pass', typed], undefined],
			[['user', 'add', 'carol@example.com', `-p${typed}`], undefined],
			[
				['user', 'add', 'carol@example.com', '--password-stdin'],
				`${typed}\nsecond line`,
			],
			[['user', 'add', 'carol@example.com', '--password-stdin'], 'Zq9-short'],
			[
				['user', 'add', 'carol@example.com', '--password-stdin'],
				`${typed}${'x'.repeat(1100)}`,
			],
			[['user', 'add', 'carol@example.com', '--password-stdin'], typed],
			[
				['user', 'passwd', 'carol@example.com', '--password-stdin'],
				`${typed}2`,
			],
			[['user', 'add', 'nobody@example.net', '--password-stdin'], typed],
			[['user', 'passwd', typed], undefined],
			[[typed], undefined],
			[['user', typed], undefined],
			[['user', 'list'], undefined],
		];
		const codes: number[] = [];
		for (const [args, stdin] of cases) {
			codes.push((await it.bumail(args, stdin)).code);
		}
		expect(codes).toEqual([2, 2, 2, 2, 4, 4, 4, 0, 0, 4, 4, 2, 2, 0]);
		const everything = it.seen.join('');
		expect(everything).not.toContain(typed);
		expect(everything).not.toContain('Zq9');
		expect(everything).not.toContain(SECRET);
		expect(everything).not.toContain('argon2');
	});
});
