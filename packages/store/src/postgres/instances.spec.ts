import { expect, test } from 'bun:test';
import { bytes } from '../contract/fixtures/setup.fixtures';
import type { MailStore } from '../contract/mail-store';
import { describePostgres, temporaryStores } from './databases.fixtures';
import { PostgresMailStore } from './store';

// Several server instances on one database: each store here has a client
// of its own, as another process would, and they run at once.

describePostgres('PostgresMailStore: several instances', (url) => {
	const { client, create, prefix, share, tablesFor } = temporaryStores(url);

	/** Two instances on one store, and a third that only reads. */
	async function instances() {
		const a = create();
		await a.migrate();
		const b = share(a);
		const reader = share(a);
		const account = await a.createAccount('mary@example.net');
		const inbox = await a.createMailbox(account.id, { name: 'INBOX' });
		const archive = await b.createMailbox(account.id, { name: 'Archive' });
		return { a, b, reader, account, inbox, archive };
	}

	test('appends to one mailbox from two instances: each UID once, in the order of their modseqs', async () => {
		const { a, b, account, inbox } = await instances();
		const added = await Promise.all(
			Array.from({ length: 80 }, (_, i) =>
				(i % 2 ? a : b).addMessage(account.id, inbox.id, {
					content: bytes(`message ${i}`),
				}),
			),
		);
		const byUid = added
			.map((m) => ({ uid: m.mailboxes[0]?.uid as number, modseq: m.modseq }))
			.sort((x, y) => x.uid - y.uid);
		expect(byUid.map((e) => e.uid)).toEqual(
			Array.from({ length: 80 }, (_, i) => i + 1),
		);
		const first = byUid[0]?.modseq as number;
		expect(byUid.map((e) => e.modseq)).toEqual(
			Array.from({ length: 80 }, (_, i) => first + i),
		);
		const mailbox = await b.getMailbox(account.id, inbox.id);
		expect(mailbox).toMatchObject({ uidNext: 81, messages: 80 });
		expect(mailbox?.highestModseq).toBe(first + 79);
		const listed = await a.listMessages(account.id, inbox.id);
		expect(listed.map((e) => e.uid)).toEqual(byUid.map((e) => e.uid));
	});

	test('instances migrating at once under a stricter default isolation level each see the tables once', async () => {
		const p = prefix();
		const levels = ['repeatable read', 'serializable'];
		const stores = Array.from({ length: 8 }, (_, i) =>
			PostgresMailStore.open({
				sql: client(2, {
					default_transaction_isolation: levels[i % 2] as string,
				}),
				tablePrefix: p,
			}),
		);
		await Promise.all(stores.map((s) => s.migrate()));
		const account = await (stores[0] as MailStore).createAccount(
			'm@example.net',
		);
		expect(await (stores[7] as MailStore).getAccount(account.id)).toEqual(
			account,
		);
	});

	test('appends and logins hold when the clients default to a stricter isolation level', async () => {
		const { a, account, inbox } = await instances();
		// Another application's client, whose sessions default to more.
		const strict = (level: string) =>
			PostgresMailStore.open({
				sql: client(4, { default_transaction_isolation: level }),
				tablePrefix: tablesFor(a),
			});
		const stores = [strict('repeatable read'), strict('serializable')];
		const added = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(stores[i % 2] as MailStore).addMessage(account.id, inbox.id, {
					content: bytes(`${i}`),
				}),
			),
		);
		expect(new Set(added.map((m) => m.mailboxes[0]?.uid)).size).toBe(20);
		const created = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) =>
				(stores[i % 2] as MailStore).createAccount('joe@example.net'),
			),
		);
		expect(created.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
		for (const c of created) {
			if (c.status === 'rejected') {
				expect(c.reason).toMatchObject({ code: 'ALREADY_EXISTS' });
			}
		}
		await Promise.all(stores.map((s) => s.close()));
	});

	test('a reader syncing while two instances write misses no change, and sees them in order', async () => {
		const { a, b, reader, account, inbox, archive } = await instances();
		const live: string[] = [];
		const write = async (store: MailStore, rounds: number) => {
			for (let i = 0; i < rounds; i++) {
				const roll = Math.random();
				const pick = () => live[Math.floor(Math.random() * live.length)];
				const target = Math.random() < 0.5 ? inbox.id : archive.id;
				if (roll < 0.4 || live.length === 0) {
					const added = await store.addMessage(account.id, target, {
						content: bytes(`${Math.random()}`),
					});
					live.push(added.id);
				} else if (roll < 0.6) {
					await store.setFlags(account.id, [pick() as string], {
						add: ['\\Seen'],
					});
				} else if (roll < 0.75) {
					const other = target === inbox.id ? archive.id : inbox.id;
					await store.moveMessages(
						account.id,
						[pick() as string],
						other,
						target,
					);
				} else if (roll < 0.85) {
					await store.linkMessages(account.id, [pick() as string], target);
				} else if (roll < 0.93) {
					await store.removeMessages(account.id, [pick() as string], target);
				} else {
					await store.destroyMessages(account.id, [pick() as string]);
				}
			}
		};
		// What a client holds of the account, and of INBOX alone.
		const held = new Set<string>();
		const inInbox = new Set<string>();
		const vanished = new Set<string>();
		let since = 0;
		let sinceInbox = 0;
		let lastExpunge = 0;
		const sync = async () => {
			for (let more = true; more; ) {
				const page = await reader.messageChanges(account.id, since, {
					limit: 7,
				});
				expect(page.modseq).toBeGreaterThanOrEqual(since);
				for (const id of page.created) held.add(id);
				for (const id of page.destroyed) held.delete(id);
				for (const gone of page.expunged) {
					// Every departure once, oldest first.
					expect(gone.modseq).toBeGreaterThan(lastExpunge);
					lastExpunge = gone.modseq;
					const key = `${gone.mailboxId}/${gone.uid}`;
					expect(vanished.has(key)).toBe(false);
					vanished.add(key);
				}
				since = page.modseq;
				more = page.hasMore;
			}
			for (let more = true; more; ) {
				const page = await reader.messageChanges(account.id, sinceInbox, {
					limit: 5,
					mailboxId: inbox.id,
				});
				for (const id of page.created) inInbox.add(id);
				for (const id of page.destroyed) inInbox.delete(id);
				sinceInbox = page.modseq;
				more = page.hasMore;
			}
		};
		let writing = true;
		const writers = Promise.all([write(a, 60), write(b, 60)]).finally(() => {
			writing = false;
		});
		while (writing) await sync();
		await writers;
		await sync();
		const all = await b.listAccountMessages(account.id);
		expect([...held].sort()).toEqual(all.messages.map((m) => m.id).sort());
		const entries = await a.listMessages(account.id, inbox.id);
		expect([...inInbox].sort()).toEqual(
			entries.map((e) => e.message.id).sort(),
		);
		// The account's last modseq is the last change any instance made.
		const modseqs = all.messages.map((m) => m.modseq);
		expect(since).toBeGreaterThanOrEqual(Math.max(0, ...modseqs));
	});

	test('the changes of one account are one sequence, whichever instance made them', async () => {
		const { a, b, reader, account, inbox } = await instances();
		const ids = [];
		for (let i = 0; i < 20; i++) {
			ids.push(
				(await a.addMessage(account.id, inbox.id, { content: bytes(`${i}`) }))
					.id,
			);
		}
		const { modseq: since } = await reader.messageChanges(account.id, 0);
		const flagged = await Promise.all(
			ids.map((id, i) =>
				(i % 2 ? a : b).setFlags(account.id, [id], { add: ['\\Flagged'] }),
			),
		);
		const modseqs = flagged.map((r) => r.messages[0]?.modseq as number);
		expect(new Set(modseqs).size).toBe(20);
		expect(modseqs.sort((x, y) => x - y)).toEqual(
			Array.from({ length: 20 }, (_, i) => since + 1 + i),
		);
		const changes = await reader.messageChanges(account.id, since);
		expect([...changes.updated].sort()).toEqual([...ids].sort());
		expect(changes.modseq).toBe(since + 20);
	});

	test('one login, one mailbox name, one role: one instance wins each', async () => {
		const { a, b, account } = await instances();
		const logins = await Promise.allSettled([
			a.createAccount('ann@example.net'),
			b.createAccount('ANN@example.net'),
		]);
		expect(logins.map((r) => r.status).sort()).toEqual([
			'fulfilled',
			'rejected',
		]);
		const boxes = await Promise.allSettled(
			[a, b, a, b].map((store) =>
				store.createMailbox(account.id, { name: 'Junk', role: 'junk' }),
			),
		);
		expect(boxes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		for (const r of boxes) {
			if (r.status === 'rejected')
				expect(r.reason).toMatchObject({ code: 'ALREADY_EXISTS' });
		}
	});

	test('UIDVALIDITY is never given twice, across accounts and instances', async () => {
		const { a, b } = await instances();
		const accounts = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				(i % 2 ? a : b).createAccount(`user${i}@example.net`),
			),
		);
		const boxes = await Promise.all(
			accounts.flatMap((account, i) =>
				Array.from({ length: 5 }, (_, j) =>
					((i + j) % 2 ? a : b).createMailbox(account.id, {
						name: `Box ${j}`,
					}),
				),
			),
		);
		const validities = boxes.map((box) => box.uidValidity);
		expect(new Set(validities).size).toBe(validities.length);
		for (const v of validities) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThanOrEqual(2 ** 32 - 1);
		}
	});

	test('a move racing a removal on another instance never leaves half a move', async () => {
		const { a, b, account, inbox, archive } = await instances();
		for (let round = 0; round < 10; round++) {
			const message = await a.addMessage(account.id, inbox.id, {
				content: bytes(`${round}`),
			});
			await Promise.allSettled([
				a.moveMessages(account.id, [message.id], inbox.id, archive.id),
				b.removeMessages(account.id, [message.id], inbox.id),
			]);
			const left = await b.getMessage(account.id, message.id);
			if (left !== undefined) {
				expect(left.mailboxes.map((m) => m.mailboxId)).toEqual([archive.id]);
			}
		}
		const [inInbox, inArchive] = await Promise.all([
			a.getMailbox(account.id, inbox.id),
			a.getMailbox(account.id, archive.id),
		]);
		expect(inInbox?.messages).toBe(0);
		expect(inArchive?.messages).toBe(
			(await a.listMessages(account.id, archive.id)).length,
		);
	});
});
