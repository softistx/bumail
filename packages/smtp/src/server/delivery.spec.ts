import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryMailStore } from '@bumail/store';
import { reply } from '../protocol/reply';
import { Client } from './client.fixtures';
import type { ReceivedMessage } from './options';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

// A real session delivering into @bumail/store's memory store, as the guide's
// "Delivering into @bumail/store" shows. The store is a devDependency only:
// @bumail/smtp needs nothing of it at runtime.

let server: SmtpServer | undefined;
afterEach(() => {
	server?.stop(true);
	server = undefined;
});

/** An MX for foo.com whose mailboxes are accounts of a memory store. */
async function start() {
	const store = new MemoryMailStore();
	const accounts = new Map<string, string>();
	for (const name of ['alice', 'bob']) {
		const account = await store.createAccount(name);
		await store.createMailbox(account.id, { name: 'INBOX', role: 'inbox' });
		accounts.set(`${name}@foo.com`, account.id);
	}
	/** Each recipient's copy goes into its inbox; one stream, teed. */
	const deliver = async ({ envelope, content }: ReceivedMessage) => {
		let rest = content;
		await Promise.all(
			envelope.to.map(async (to, index) => {
				let mine = rest;
				if (index < envelope.to.length - 1) [mine, rest] = rest.tee();
				const accountId = accounts.get(to.toLowerCase()) ?? '';
				const inbox = await store.findMailbox(accountId, 'inbox');
				await store.addMessage(accountId, inbox?.id ?? '', {
					content: mine,
				});
			}),
		);
	};
	server = createSmtpServer(
		mxOptions({
			onRcptTo: (path) =>
				accounts.has(path.address.toLowerCase())
					? undefined
					: reply(550, '5.1.1', 'No such user here'),
			onData: deliver,
		}),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const inboxOf = async (address: string) => {
		const accountId = accounts.get(address) ?? '';
		const inbox = await store.findMailbox(accountId, 'inbox');
		const entries = await store.listMessages(accountId, inbox?.id ?? '');
		return { accountId, entries };
	};
	return { port, store, inboxOf };
}

/** A session up to the reply to DATA's end. */
async function send(port: number, to: readonly string[], body: string) {
	const client = await Client.connect(port);
	await client.reply();
	await client.command('EHLO bar.com');
	await client.command('MAIL FROM:<sender@bar.com>');
	const rcpt: string[] = [];
	for (const address of to) {
		rcpt.push(await client.command(`RCPT TO:<${address}>`));
	}
	const data = await client.command('DATA');
	const end = data.startsWith('354') ? await client.command(`${body}.`) : data;
	await client.command('QUIT');
	return { rcpt, end };
}

const MESSAGE = 'From: sender@bar.com\r\nSubject: hi\r\n\r\nhello\r\n';

describe('delivering into @bumail/store', () => {
	test('the stored bytes are the Received field and the message as sent, in INBOX with a UID', async () => {
		const { port, store, inboxOf } = await start();
		const { end } = await send(port, ['alice@foo.com'], MESSAGE);
		expect(end).toStartWith('250 2.0.0 OK queued as');
		const { accountId, entries } = await inboxOf('alice@foo.com');
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry?.uid).toBe(1);
		const blob = await store.readContent(
			accountId,
			entry?.message.blobId ?? '',
		);
		const text = (await blob?.text()) ?? '';
		const id = end.match(/queued as (\w+)/)?.[1] ?? '';
		expect(text).toStartWith('Received: from bar.com ([127.0.0.1])\r\n');
		expect(text).toContain(` id ${id}\r\n\tfor <alice@foo.com>; `);
		expect(text).toEndWith(`\r\n${MESSAGE}`);
	});

	test('a second recipient gets its own copy, in its own account', async () => {
		const { port, store, inboxOf } = await start();
		const { end } = await send(port, ['alice@foo.com', 'bob@foo.com'], MESSAGE);
		expect(end).toStartWith('250');
		for (const address of ['alice@foo.com', 'bob@foo.com']) {
			const { accountId, entries } = await inboxOf(address);
			expect(entries).toHaveLength(1);
			const blob = await store.readContent(
				accountId,
				entries[0]?.message.blobId ?? '',
			);
			expect(await blob?.text()).toEndWith(MESSAGE);
		}
	});

	test('without AUTH, mail for another domain is refused and nothing is stored', async () => {
		const { port, inboxOf } = await start();
		const { rcpt, end } = await send(port, ['victim@evil.com'], MESSAGE);
		expect(rcpt[0]).toBe('554 5.7.1 Relay access denied\r\n');
		expect(end).toStartWith('554');
		for (const address of ['alice@foo.com', 'bob@foo.com']) {
			expect((await inboxOf(address)).entries).toEqual([]);
		}
	});

	test('a recipient the app refuses gets no copy; the others do', async () => {
		const { port, inboxOf } = await start();
		const { rcpt, end } = await send(
			port,
			['nobody@foo.com', 'bob@foo.com'],
			MESSAGE,
		);
		expect(rcpt[0]).toBe('550 5.1.1 No such user here\r\n');
		expect(end).toStartWith('250');
		expect((await inboxOf('bob@foo.com')).entries).toHaveLength(1);
		expect((await inboxOf('alice@foo.com')).entries).toEqual([]);
	});

	test('a message the server refuses mid-stream (a bare LF) is stored nowhere', async () => {
		const { port, inboxOf } = await start();
		const { end } = await send(
			port,
			['alice@foo.com', 'bob@foo.com'],
			'Subject: hi\r\n\r\nsmuggled\nMAIL FROM:<x@evil.com>\r\n',
		);
		expect(end).toBe(
			'550 5.6.11 Bare CR or LF is not allowed in a message\r\n',
		);
		for (const address of ['alice@foo.com', 'bob@foo.com']) {
			expect((await inboxOf(address)).entries).toEqual([]);
		}
	});
});
