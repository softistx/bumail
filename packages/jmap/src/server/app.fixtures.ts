import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alxia } from '@alxia/core';
import { type MailStore, MemoryMailStore } from '@bumail/store';
import { SqliteMailStore } from '@bumail/store/sqlite';
import { jmap } from './jmap';
import type { JmapOptions } from './options';

export const CORE = 'urn:ietf:params:jmap:core';
export const MAIL = 'urn:ietf:params:jmap:mail';
export const ORIGIN = 'https://mail.example.com';

export type StoreKind = 'memory' | 'sqlite';
export const STORES: StoreKind[] = ['memory', 'sqlite'];

/** A store of either kind, and how to throw it away. */
export async function openStore(
	kind: StoreKind,
): Promise<{ store: MailStore; close(): Promise<void> }> {
	if (kind === 'memory')
		return { store: new MemoryMailStore(), close: async () => {} };
	const directory = await mkdtemp(join(tmpdir(), 'bumail-jmap-'));
	const store = SqliteMailStore.open({ directory });
	return {
		store,
		close: async () => {
			store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** RFC 5322 §A.1.1's message, with a Message-ID. */
export const SIMPLE = [
	'From: John Doe <jdoe@machine.example>',
	'To: Mary Smith <mary@example.net>',
	'Subject: Saying Hello',
	'Date: Fri, 21 Nov 1997 09:55:06 -0600',
	'Message-ID: <1234@local.machine.example>',
	'',
	'This is a message just to say hello.',
	'So, "Hello".',
	'',
].join('\r\n');

export const MULTIPART = [
	'From: =?utf-8?q?Ren=C3=A9?= <rene@example.com>',
	'To: alice@example.com, Team: bob@example.com;',
	'Subject: Re: Report attached',
	'Date: Tue, 2 Feb 2027 10:00:00 +0000',
	'In-Reply-To: <1234@local.machine.example>',
	'Content-Type: multipart/mixed; boundary="b1"',
	'',
	'--b1',
	'Content-Type: multipart/alternative; boundary="b2"',
	'',
	'--b2',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'See the report.',
	'--b2',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>See the <b>report</b>.</p>',
	'--b2--',
	'--b1',
	'Content-Type: application/pdf; name="report.pdf"',
	'Content-Disposition: attachment; filename="report.pdf"',
	'Content-Transfer-Encoding: base64',
	'',
	'JVBERi0xLjQK',
	'--b1--',
	'',
].join('\r\n');

export const bytes = (text: string) => new TextEncoder().encode(text);

/** Alice's account with an INBOX and an Archive, and bob's with an INBOX. */
async function seed(store: MailStore) {
	const alice = await store.createAccount('alice@example.com');
	const bob = await store.createAccount('bob@example.com');
	const inbox = await store.createMailbox(alice.id, {
		name: 'INBOX',
		role: 'inbox',
	});
	const archive = await store.createMailbox(alice.id, {
		name: 'Archive',
		role: 'archive',
	});
	const bobInbox = await store.createMailbox(bob.id, {
		name: 'INBOX',
		role: 'inbox',
	});
	return { alice, bob, inbox, archive, bobInbox };
}

type Init = RequestInit & { token?: string };
type ApiInit = {
	using?: string[];
	token?: string;
	createdIds?: Record<string, string>;
};

/** Requests to a host app, as alice unless another token is given. */
function clientOf(
	host: { fetch(request: Request): Response | Promise<Response> },
	accountId: string,
) {
	const fetch = async (path: string, init: Init = {}) => {
		const headers = new Headers(init.headers);
		if (!headers.has('authorization'))
			headers.set('authorization', `Bearer ${init.token ?? 'alice-token'}`);
		return host.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
	};
	const api = async (methodCalls: unknown[], init: ApiInit = {}) => {
		const response = await fetch('/jmap/api', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				using: init.using ?? [CORE, MAIL],
				methodCalls,
				...(init.createdIds ? { createdIds: init.createdIds } : {}),
			}),
			...(init.token === undefined ? {} : { token: init.token }),
		});
		return (await response.json()) as {
			methodResponses: [string, any, string][];
			sessionState: string;
			createdIds?: Record<string, string>;
		};
	};
	/** One call's response arguments, the account filled in. */
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const { methodResponses } = await api([
			[name, { accountId, ...args }, 'c'],
		]);
		const [response] = methodResponses;
		return { name: response?.[0], args: response?.[1] as any };
	};
	return { fetch, api, call };
}

/**
 * A JMAP server on a store with alice's and bob's accounts, mounted in a
 * host app and called through its `fetch`, in process. Alice's token is
 * `alice-token`, bob's `bob-token`.
 */
export async function harness(
	kind: StoreKind = 'memory',
	overrides: Partial<JmapOptions> = {},
) {
	const { store, close } = await openStore(kind);
	const seeded = await seed(store);
	const { alice, bob, inbox } = seeded;
	const tokens = new Map([
		['alice-token', alice.id],
		['bob-token', bob.id],
	]);
	const server = jmap({
		store,
		origin: ORIGIN,
		authenticate: (credentials) =>
			credentials.scheme === 'bearer'
				? (tokens.get(credentials.token) ?? null)
				: null,
		...overrides,
	});
	const host = alxia()
		.use(server)
		.get('/health', ({ reply }) => reply(200, 'ok'));
	const add = (
		content: string,
		mailboxId = inbox.id,
		flags: string[] = [],
		receivedAt?: Date,
	) =>
		store.addMessage(alice.id, mailboxId, {
			content: bytes(content),
			flags,
			...(receivedAt ? { receivedAt } : {}),
		});
	return {
		store,
		close,
		...seeded,
		server,
		host,
		...clientOf(host, alice.id),
		add,
	};
}

export type Harness = Awaited<ReturnType<typeof harness>>;
