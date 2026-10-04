import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ImapServerOptions } from '@bumail/imap';
import type { JmapOptions } from '@bumail/jmap';
import type { SmtpServerOptions } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';
import { SqliteMailStore } from '@bumail/store/sqlite';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import { MAILBOXES, provisionAccount, purgeAccount } from './accounts';
import {
	BUSY_MESSAGE,
	imapAuthenticate,
	jmapAuthenticate,
	smtpAuthenticate,
} from './adapters';
import type { AuthResult } from './authenticate';
import type { Directory } from './directory';
import { PASSWORD, seededDirectory } from './directory.fixtures';
import { openStore } from './store';

const closing: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of closing.splice(0)) await close();
});

function sqliteStore(directory = join(tempDir(), 'mail')): SqliteMailStore {
	const store = SqliteMailStore.open({ directory });
	closing.push(() => store.close());
	return store;
}

async function directory(): Promise<Directory> {
	const seeded = await seededDirectory();
	closing.push(() => seeded.close());
	return seeded;
}

describe('provisionAccount', () => {
	test('creates the account, named by the address, with its six mailboxes', async () => {
		const store = sqliteStore();
		const account = await provisionAccount(store, 'alice@example.com');
		expect(account.name).toBe('alice@example.com');
		const mailboxes = await store.listMailboxes(account.id);
		expect(mailboxes.map(({ name, role }) => [name, role]).sort()).toEqual(
			MAILBOXES.map(([name, role]) => [name, role]).sort(),
		);
	});

	test('is safe to run again and at once, keeping what is there', async () => {
		const store = sqliteStore();
		const [first, second] = await Promise.all([
			provisionAccount(store, 'alice@example.com'),
			provisionAccount(store, 'alice@example.com'),
		]);
		expect(second.id).toBe(first.id);
		const trash = await store.findMailbox(first.id, 'trash');
		await store.renameMailbox(first.id, trash?.id ?? '', { name: 'Bin' });
		const junk = await store.findMailbox(first.id, 'junk');
		await store.deleteMailbox(first.id, junk?.id ?? '');
		expect((await provisionAccount(store, 'alice@example.com')).id).toBe(
			first.id,
		);
		const names = (await store.listMailboxes(first.id)).map(({ name }) => name);
		expect(names).toContain('Bin');
		expect(names).toContain('Junk');
		expect(names).not.toContain('Trash');
	});

	test('finds an account kept from a user removed earlier, with its mail', async () => {
		const store = new MemoryMailStore();
		const account = await provisionAccount(store, 'alice@example.com');
		const inbox = await store.findMailbox(account.id, 'inbox');
		await store.addMessage(account.id, inbox?.id ?? '', {
			content: new TextEncoder().encode('Subject: kept\r\n\r\nhi\r\n'),
		});
		const again = await provisionAccount(store, 'Alice@example.com');
		expect(again.id).toBe(account.id);
		expect((await store.listAccountMessages(account.id)).messages.length).toBe(
			1,
		);
	});
});

describe('purgeAccount', () => {
	test('deletes the account and its mail; false when there is none', async () => {
		const store = sqliteStore();
		const account = await provisionAccount(store, 'alice@example.com');
		expect(await purgeAccount(store, 'alice@example.com')).toBe(true);
		expect(await store.getAccount(account.id)).toBeUndefined();
		expect(await purgeAccount(store, 'alice@example.com')).toBe(false);
	});
});

describe('openStore', () => {
	test('opens a sqlite: store, and says when another process holds it', async () => {
		const dir = join(tempDir(), 'mail');
		const { store, close } = openStore({
			url: `sqlite:${dir}`,
			plaintext: false,
		});
		closing.push(close);
		await provisionAccount(store, 'alice@example.com');
		let error: unknown;
		try {
			openStore({ url: `sqlite:${dir}`, plaintext: false });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ServerError);
		expect((error as ServerError).message).toBe(
			'the mail store is in use by another process, such as the running server',
		);
	});
});

describe('the adapters', () => {
	test('fit the authenticate of @bumail/smtp, @bumail/imap and @bumail/jmap', async () => {
		const dir = await directory();
		const store = new MemoryMailStore();
		const smtp: SmtpServerOptions['authenticate'] = smtpAuthenticate(dir);
		const imap: ImapServerOptions['authenticate'] = imapAuthenticate(
			dir,
			store,
		);
		const jmap: JmapOptions['authenticate'] = jmapAuthenticate(
			dir,
			store,
			() => '192.0.2.1',
		);
		expect([typeof smtp, typeof imap, typeof jmap]).toEqual([
			'function',
			'function',
			'function',
		]);
	});

	test('smtp answers true for the right password only', async () => {
		const dir = await directory();
		const smtp = smtpAuthenticate(dir);
		const session = { remoteAddress: '192.0.2.1' };
		expect(
			await smtp(
				{ username: 'alice@example.com', password: PASSWORD },
				session,
			),
		).toBe(true);
		expect(
			await smtp(
				{ username: 'alice@example.com', password: 'wrong guess' },
				session,
			),
		).toBe(false);
	});

	test('imap answers the store account, creating it with its mailboxes at the first login', async () => {
		const dir = await directory();
		const store = sqliteStore();
		const refused: [string, string][] = [];
		const imap = imapAuthenticate(dir, store, {
			onRefused: (reason, ip) => refused.push([reason, ip]),
		});
		const session = { remoteAddress: '192.0.2.7' };
		const id = await imap(
			{ username: 'Bob@example.com', password: PASSWORD },
			session,
		);
		expect((await store.findAccount('bob@example.com'))?.id).toBe(id ?? '');
		expect(await store.findMailbox(id ?? '', 'inbox')).toBeDefined();
		expect(
			await imap({ username: 'bob@example.com', password: PASSWORD }, session),
		).toBe(id);
		expect(
			await imap(
				{ username: 'nobody@example.com', password: PASSWORD },
				session,
			),
		).toBeNull();
		expect(refused).toEqual([['unknown', '192.0.2.7']]);
	});

	test('jmap takes Basic with the address ipOf gives, and refuses a Bearer token', async () => {
		const dir = await directory();
		const store = new MemoryMailStore();
		const ips: string[] = [];
		const jmap = jmapAuthenticate(dir, store, (request) => {
			ips.push(request.headers.get('x-test-ip') ?? '');
			return request.headers.get('x-test-ip') ?? '';
		});
		const request = new Request('https://mail.example.com/jmap', {
			headers: { 'x-test-ip': '2001:db8::1' },
		});
		const id = await jmap(
			{ scheme: 'basic', username: 'alice@example.com', password: PASSWORD },
			request,
		);
		expect(id).toBe((await store.findAccount('alice@example.com'))?.id ?? '');
		expect(await jmap({ scheme: 'bearer', token: 'abc' }, request)).toBeNull();
		expect(ips).toEqual(['2001:db8::1']);
	});

	test('busy is thrown, for each listener to answer as a temporary failure', async () => {
		const busy = {
			authenticate: async (): Promise<AuthResult> => ({
				ok: false,
				reason: 'busy',
			}),
		};
		const smtp = smtpAuthenticate(busy);
		await expect(
			smtp({ username: 'a@example.com', password: 'x' }, { remoteAddress: '' }),
		).rejects.toThrow(BUSY_MESSAGE);
	});
});
