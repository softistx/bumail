#!/usr/bin/env bun
/**
 * The README's example: a JMAP server on a memory store, mounted in a host
 * alxia app beside a route of its own. Run it, then ask for the session:
 *
 *   bun run build
 *   bun packages/jmap/examples/serve.ts
 *   curl -H 'Authorization: Bearer alice-secret-token' http://localhost:8080/.well-known/jmap
 *
 * The port, the origin and the token come from PORT, JMAP_ORIGIN and
 * ALICE_TOKEN when they are set.
 */
import { alxia } from '@alxia/core';
import { jmap } from '@bumail/jmap';
import { MemoryMailStore } from '@bumail/store';

const store = new MemoryMailStore();
const alice = await store.createAccount('alice@example.com');
const inbox = await store.createMailbox(alice.id, {
	name: 'INBOX',
	role: 'inbox',
});
await store.createMailbox(alice.id, { name: 'Sent', role: 'sent' });
await store.addMessage(alice.id, inbox.id, {
	content: new TextEncoder().encode(
		'From: Bob <bob@example.com>\r\nTo: alice@example.com\r\nSubject: Hello\r\n\r\nHi Alice!\r\n',
	),
});

const port = Number(Bun.env['PORT'] ?? 8080);
const tokens = new Map([
	[Bun.env['ALICE_TOKEN'] ?? 'alice-secret-token', alice.id],
]);
const passwords = new Map([
	['alice', await Bun.password.hash('correct horse')],
]);

export const server = jmap({
	store,
	origin: Bun.env['JMAP_ORIGIN'] ?? `http://localhost:${port}`,
	async authenticate(credentials) {
		if (credentials.scheme === 'bearer')
			return tokens.get(credentials.token) ?? null;
		const hash = passwords.get(credentials.username);
		if (!hash || !(await Bun.password.verify(credentials.password, hash)))
			return null;
		return alice.id;
	},
	onError: (error, { method }) => console.error(method ?? 'jmap', error),
});

export const app = alxia()
	.get('/health', ({ reply }) => reply(200, 'ok'))
	.use(server);

if (import.meta.main) {
	app.listen(port);
	console.log(`JMAP on http://localhost:${port}/.well-known/jmap`);
}
