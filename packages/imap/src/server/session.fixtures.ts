import { MemoryMailStore } from '@bumail/store';
import { Connection } from './connection';
import type { ImapServerOptions } from './options';
import { settingsOf } from './settings';
import type { Transport } from './transport';

/** For specs only: what STARTTLS needs to be offered. */
export const FAKE_TLS = { key: 'fake', cert: 'fake' };

export const SIMPLE = [
	'Date: Mon, 7 Feb 1994 21:52:25 -0800',
	'From: Fred Foobar <foobar@Blurdybloop.example>',
	'Subject: afternoon meeting',
	'To: mooch@owatagu.siam.edu.example',
	'Message-Id: <B27397-0100000@Blurdybloop.example>',
	'MIME-Version: 1.0',
	'Content-Type: TEXT/PLAIN; CHARSET=US-ASCII',
	'',
	'Hello Joe, do you think we can meet at 3:30 tomorrow?',
	'',
].join('\r\n');

export const MULTIPART = [
	'From: =?utf-8?q?Ren=C3=A9?= <rene@example.com>',
	'To: alice@example.com, Team: bob@example.com;',
	'Subject: Report attached',
	'Date: Tue, 2 Feb 2027 10:00:00 +0000',
	'Content-Type: multipart/mixed; boundary="b1"',
	'',
	'--b1',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'See the report.',
	'Second line.',
	'--b1',
	'Content-Type: application/pdf; name="report.pdf"',
	'Content-Disposition: attachment; filename="report.pdf"',
	'Content-Transfer-Encoding: base64',
	'',
	'JVBERi0xLjQK',
	'--b1--',
	'',
].join('\r\n');

/** A memory store with alice's account: INBOX with two messages, and the special-use mailboxes. */
export async function seededStore() {
	const store = new MemoryMailStore();
	const account = await store.createAccount('alice@example.com');
	const accountId = account.id;
	const inbox = await store.createMailbox(accountId, {
		name: 'INBOX',
		role: 'inbox',
	});
	const archive = await store.createMailbox(accountId, {
		name: 'Archive',
		role: 'archive',
	});
	await store.createMailbox(accountId, { name: 'Sent', role: 'sent' });
	await store.createMailbox(accountId, {
		name: 'Trash',
		role: 'trash',
		isSubscribed: false,
	});
	const encoder = new TextEncoder();
	await store.addMessage(accountId, inbox.id, {
		content: encoder.encode(SIMPLE),
		receivedAt: new Date('1994-02-08T05:52:25Z'),
	});
	await store.addMessage(accountId, inbox.id, {
		content: encoder.encode(MULTIPART),
		flags: ['\\Flagged'],
		receivedAt: new Date('2027-02-02T10:00:05Z'),
	});
	return { store, accountId, inbox, archive };
}

export function imapOptions(
	store: MemoryMailStore,
	accountId: string,
	overrides: Partial<ImapServerOptions> = {},
): ImapServerOptions {
	return {
		hostname: 'imap.example.com',
		store,
		tls: FAKE_TLS,
		authenticate: ({ username, password }) =>
			username === 'alice' && password === 'secret' ? accountId : null,
		...overrides,
	};
}

export interface FakeSession {
	readonly connection: Connection;
	readonly greeting: string;
	/** Sends text, waits for every answer to it, and returns what the server wrote. */
	send(text: string): Promise<string>;
	/** What the server wrote since the last `send` or `take`. */
	take(): string;
	/** Waits until what the server wrote passes `check`, for `seconds` at most. */
	until(check: (output: string) => boolean, seconds?: number): Promise<string>;
	readonly ended: boolean;
	readonly tlsStarts: number;
	readonly errors: unknown[];
	/** Stops the fake socket from taking bytes, as a client that reads nothing. */
	stall(): void;
	/** Bytes written while stalled, held by the transport. */
	readonly backlog: number;
}

function fakeTransport(secure: boolean) {
	let output = '';
	let ended = false;
	let tlsStarts = 0;
	let encrypted = secure;
	let stalled = false;
	let backlog = 0;
	const decoder = new TextDecoder();
	const transport: Transport = {
		remoteAddress: '192.0.2.10',
		get secure() {
			return encrypted;
		},
		get backlog() {
			return backlog;
		},
		write: (bytes) => {
			if (stalled) backlog += bytes.length;
			else output += decoder.decode(bytes);
		},
		drained: () => (stalled ? new Promise(() => {}) : Promise.resolve()),
		end: () => {
			ended = true;
		},
		abort: () => {
			ended = true;
			backlog = 0;
		},
		pause: () => {},
		resume: () => {},
		startTls: () => {
			tlsStarts++;
			encrypted = true;
		},
	};
	return {
		transport,
		take() {
			const taken = output;
			output = '';
			return taken;
		},
		peek: () => output,
		stall: () => {
			stalled = true;
		},
		get backlog() {
			return backlog;
		},
		get ended() {
			return ended;
		},
		get tlsStarts() {
			return tlsStarts;
		},
	};
}

/** A session on a fake socket, encrypted unless `secure: false`. */
export async function fakeSession(
	options: ImapServerOptions,
	{ secure = true } = {},
): Promise<FakeSession> {
	const errors: unknown[] = [];
	const fake = fakeTransport(secure);
	const settings = settingsOf({
		...options,
		onError: (error) => errors.push(error),
	});
	const connection = new Connection(settings, fake.transport);
	await connection.open();
	const greeting = fake.take();
	return {
		connection,
		greeting,
		errors,
		take: fake.take,
		stall: fake.stall,
		get backlog() {
			return fake.backlog;
		},
		get ended() {
			return fake.ended;
		},
		get tlsStarts() {
			return fake.tlsStarts;
		},
		async send(text) {
			connection.receive(new TextEncoder().encode(text));
			await connection.idle();
			return fake.take();
		},
		async until(check, seconds = 5) {
			const end = Date.now() + seconds * 1000;
			while (!check(fake.peek()) && Date.now() < end) await Bun.sleep(5);
			return fake.take();
		},
	};
}

/** A session logged in as alice, IMAP4rev1 unless `rev2`. */
export async function loggedIn(
	options: ImapServerOptions,
	{ rev2 = false } = {},
): Promise<FakeSession> {
	const session = await fakeSession(options);
	await session.send('L1 LOGIN alice secret\r\n');
	if (rev2) await session.send('E1 ENABLE IMAP4rev2\r\n');
	return session;
}
