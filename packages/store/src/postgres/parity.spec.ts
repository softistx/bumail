import { afterAll, expect, test } from 'bun:test';
import type { MailStore } from '../contract/mail-store';
import { MemoryMailStore } from '../memory/store';
import { describePostgres, temporaryStores } from './databases.fixtures';

// Random histories run on the memory store and on PostgreSQL side by
// side: every answer and every error must be the same, ids aside. Ids are
// random in each store, so each is named by the order it first appeared.
// BUMAIL_PARITY_HISTORIES runs more of them (and BUMAIL_PARITY_SEED one).

const stats = new Map<string, number>();
afterAll(() => {
	if (stats.size > 0) console.log([...stats].sort());
});

const HISTORIES = Number(process.env['BUMAIL_PARITY_HISTORIES'] ?? 12);
const STEPS = 90;

/** A small, seeded generator, so a failing history can be run again. */
function random(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (n: number) => Math.floor(next() * n);
	const pick = <T>(list: readonly T[]): T | undefined => list[int(list.length)];
	const some = <T>(list: readonly T[]) => list.filter(() => next() < 0.4);
	return { next, int, pick, some };
}

/** Names each id one store made by the order it made them. */
class Names {
	readonly #names = new Map<string, string>();
	readonly #ids = new Map<string, string>();

	/** Learns the ids of what a call made: an account, a mailbox, messages. */
	learn(value: unknown): void {
		const made = value as { id?: unknown; messages?: { id: string }[] } | null;
		if (typeof made?.id === 'string') this.#name(made.id);
		else if (Array.isArray(made?.messages))
			for (const message of made.messages) this.#name(message.id);
	}

	#name(id: string): void {
		if (this.#names.has(id)) return;
		const name = `#${this.#names.size}`;
		this.#names.set(id, name);
		this.#ids.set(name, id);
	}

	/** The id this store gave the name. */
	id(name: string): string {
		return this.#ids.get(name) ?? name;
	}

	/** The answer with every id it knows as its name; `uidValidity` dropped: each store counts its own. */
	show(value: unknown): unknown {
		if (value === undefined) return null;
		const known = this.#names;
		return JSON.parse(
			JSON.stringify(value, (key, v) => {
				if (key === 'uidValidity') return undefined;
				if (typeof v !== 'string') return v;
				let out = known.get(v) ?? v;
				for (const [id, name] of known) out = out.replaceAll(id, name);
				return out;
			}),
		);
	}
}

interface Side {
	store: MailStore;
	names: Names;
}

/** One call on a store, as data: its answer or its error, with ids named. */
async function outcome(
	side: Side,
	call: (store: MailStore, id: (name: string) => string) => Promise<unknown>,
	made: boolean,
): Promise<unknown> {
	try {
		let value = await call(side.store, (name) => side.names.id(name));
		if (value instanceof Blob) value = { blob: await value.text() };
		if (made) side.names.learn(value);
		return { ok: side.names.show(value) };
	} catch (error) {
		const e = error as { name?: string; code?: string; message?: string };
		return {
			error: side.names.show({
				name: e.name,
				code: e.code,
				message: e.message,
			}),
		};
	}
}

describePostgres('PostgresMailStore: parity with the memory store', (url) => {
	const { create } = temporaryStores(url);
	const seeds = process.env['BUMAIL_PARITY_SEED']
		? [Number(process.env['BUMAIL_PARITY_SEED'])]
		: Array.from({ length: HISTORIES }, (_, i) => 1000 + i);

	for (const seed of seeds) {
		test(`history ${seed}: the same answers`, async () => {
			const r = random(seed);
			const dense = seed % 2 === 1;
			const maxTombstones = !dense && r.next() < 0.4 ? r.int(6) : undefined;
			const options = maxTombstones === undefined ? {} : { maxTombstones };
			const sides: Side[] = [
				{ store: new MemoryMailStore(options), names: new Names() },
				{ store: create(options), names: new Names() },
			];
			// What the history knows, by name: the same on both sides.
			const accounts: string[] = [];
			// Every mailbox and message made, with its account; a mailbox until deleted.
			const made: {
				name: string;
				account: string;
				mailbox: boolean;
				live: boolean;
			}[] = [];
			const blobs: string[] = [];
			const modseqs: number[] = [0];
			const log: string[] = [];
			const step = async (
				label: string,
				call: (
					store: MailStore,
					id: (name: string) => string,
				) => Promise<unknown>,
			) => {
				log.push(label);
				const makes = /^(create|addMessage|copyMessages)/.test(label);
				const [memory, postgres] = [
					await outcome(sides[0] as Side, call, makes),
					await outcome(sides[1] as Side, call, makes),
				];
				if (JSON.stringify(memory) !== JSON.stringify(postgres)) {
					expect({ seed, steps: log, answer: postgres }).toEqual({
						seed,
						steps: log,
						answer: memory,
					});
				}
				if (process.env['BUMAIL_PARITY_STATS']) {
					const verb = label.split(' ')[0] as string;
					const ok =
						'ok' in (memory as object)
							? 'ok'
							: JSON.stringify((memory as { error: unknown }).error).slice(
									0,
									80,
								);
					stats.set(`${verb} ${ok}`, (stats.get(`${verb} ${ok}`) ?? 0) + 1);
				}
				return memory as { ok?: unknown };
			};
			const collect = (answer: { ok?: unknown }) => {
				const text = JSON.stringify(answer.ok ?? null);
				for (const [, blob] of text.matchAll(/"blobId":"([0-9a-f]{64})"/g)) {
					if (!blobs.includes(blob as string)) blobs.push(blob as string);
				}
				for (const [, m] of text.matchAll(/"modseq":(\d+)/g)) {
					modseqs.push(Number(m));
				}
			};
			for (const login of ['mary@example.net', 'john@example.net']) {
				const made = await step(`createAccount ${login}`, (s) =>
					s.createAccount(login),
				);
				accounts.push((made.ok as { id: string }).id);
			}
			if (dense) {
				const account = accounts[0] as string;
				for (const name of ['INBOX', 'Work', 'Lists']) {
					const box = (
						await step(`createMailbox ${name}`, (s, id) =>
							s.createMailbox(id(account), { name }),
						)
					).ok as { id: string };
					made.push({ name: box.id, account, mailbox: true, live: true });
				}
			}
			const names = ['INBOX', 'Work', 'Lists', 'Archive', 'inbox', 'Été'];
			const roles = [undefined, 'inbox', 'archive', 'trash', 'junk'] as const;
			const flags = [
				'\\Seen',
				'\\Flagged',
				'\\Deleted',
				'$Junk',
				'$junk',
				'Label',
			];
			const texts = ['a', 'b', 'Subject: x\r\n\r\ny\r\n', ''];
			for (let i = 0; i < STEPS; i++) {
				const account = (
					r.next() < 0.85 ? accounts[0] : r.pick(accounts)
				) as string;
				const mailboxes = made
					.filter((m) => m.mailbox && m.live && m.account === account)
					.map((m) => m.name);
				// The messages that still exist, as the memory store says.
				const memory = sides[0] as Side;
				const present = new Set(
					(
						await memory.store.listAccountMessages(memory.names.id(account))
					).messages.map((m) => memory.names.show(m.id) as string),
				);
				const messages = made
					.filter(
						(m) => !m.mailbox && m.account === account && present.has(m.name),
					)
					.map((m) => m.name);
				const box = () => {
					const roll = r.next();
					if (roll < 0.04) return 'no-such-mailbox';
					if (roll < 0.1)
						return r.pick(made.filter((m) => m.mailbox))?.name ?? 'none';
					return r.pick(mailboxes) ?? 'none';
				};
				const ids = () => {
					const chosen = r.some(messages);
					if (r.next() < 0.1) chosen.push('no-such-message');
					if (r.next() < 0.05) chosen.push(r.pick(made)?.name ?? 'none');
					if (r.next() < 0.1 && chosen[0]) chosen.push(chosen[0]);
					return chosen;
				};
				const a = account as string;
				// A dense history keeps a few messages moving between a few
				// mailboxes, and syncs often: where the changes' rules meet.
				const kind =
					dense && mailboxes.length >= 2
						? (r.pick(
								messages.length < 4
									? [2, 6, 8, 9, 9, 10, 14, 14]
									: [6, 8, 9, 9, 10, 11, 14, 14, 14],
							) as number)
						: r.int(19);
				let answer: { ok?: unknown };
				if (kind < 2 || mailboxes.length === 0) {
					const name = r.pick(names) as string;
					const parentId = r.next() < 0.3 ? r.pick(mailboxes) : undefined;
					const role = r.pick(roles);
					const sub = r.next() < 0.2 ? false : undefined;
					answer = await step(`createMailbox ${name}`, (s, id) =>
						s.createMailbox(id(a), {
							name,
							...(parentId ? { parentId: id(parentId) } : {}),
							...(role ? { role } : {}),
							...(sub === undefined ? {} : { isSubscribed: sub }),
						}),
					);
					const box = answer.ok as { id: string } | undefined;
					if (box)
						made.push({ name: box.id, account, mailbox: true, live: true });
				} else if (kind < 6) {
					const content = new TextEncoder().encode(r.pick(texts));
					const given = r.some(flags);
					const thread = r.next() < 0.2 ? r.pick(messages) : undefined;
					const at = new Date(1_700_000_000_000 + r.int(1e9));
					const target = box();
					answer = await step(`addMessage to ${target}`, (s, id) =>
						s.addMessage(id(a), id(target), {
							content,
							flags: given,
							receivedAt: at,
							...(thread ? { threadId: id(thread) } : {}),
						}),
					);
					const added = answer.ok as { id: string } | undefined;
					if (added)
						made.push({ name: added.id, account, mailbox: false, live: true });
				} else if (kind === 6) {
					const which = ids();
					const change =
						r.next() < 0.3
							? { set: r.some(flags) }
							: { add: r.some(flags), remove: r.some(flags) };
					const since =
						r.next() < 0.3 ? { unchangedSince: r.pick(modseqs) ?? 0 } : {};
					answer = await step('setFlags', (s, id) =>
						s.setFlags(id(a), which.map(id), change, since),
					);
				} else if (kind === 7) {
					const which = ids();
					const target = box();
					answer = await step('copyMessages', (s, id) =>
						s.copyMessages(id(a), which.map(id), id(target)),
					);
					const copied = answer.ok as
						| { messages: { id: string }[] }
						| undefined;
					for (const copy of copied?.messages ?? [])
						made.push({ name: copy.id, account, mailbox: false, live: true });
				} else if (kind === 8) {
					const which = ids();
					const target = box();
					answer = await step('linkMessages', (s, id) =>
						s.linkMessages(id(a), which.map(id), id(target)),
					);
				} else if (kind === 9 || kind === 18) {
					const which = ids();
					const [from, to] = [box(), box()];
					answer = await step('moveMessages', (s, id) =>
						s.moveMessages(id(a), which.map(id), id(from), id(to)),
					);
				} else if (kind === 10) {
					const which = ids();
					const from = box();
					answer = await step('removeMessages', (s, id) =>
						s.removeMessages(id(a), which.map(id), id(from)),
					);
				} else if (kind === 11) {
					const which = ids();
					answer = await step('destroyMessages', (s, id) =>
						s.destroyMessages(id(a), which.map(id)),
					);
				} else if (kind === 12) {
					const target = box();
					const change =
						r.next() < 0.5
							? { name: r.pick(names) as string }
							: {
									parentId: r.next() < 0.5 ? null : (r.pick(mailboxes) ?? null),
								};
					answer = await step('renameMailbox', (s, id) =>
						s.renameMailbox(id(a), id(target), {
							...change,
							...('parentId' in change && change.parentId
								? { parentId: id(change.parentId) }
								: {}),
						} as never),
					);
				} else if (kind === 13) {
					const target = box();
					const removeMessages = r.next() < 0.6;
					answer = await step('deleteMailbox', (s, id) =>
						s.deleteMailbox(id(a), id(target), { removeMessages }),
					);
					if ('ok' in answer) {
						for (const m of made) if (m.name === target) m.live = false;
					}
				} else if (kind === 14) {
					// A client syncing: every page from a since, to the end.
					const since = r.next() < 0.2 ? 0 : (r.pick(modseqs) as number);
					const limit = r.next() < 0.2 ? undefined : 1 + r.int(4);
					const filter = r.next() < 0.6 ? box() : undefined;
					answer = await step(
						`messageChanges ${since} ${limit}`,
						async (s, id) => {
							const pages = [];
							for (let at = since, more = true; more && pages.length < 50; ) {
								const page = await s.messageChanges(id(a), at, {
									...(limit ? { limit } : {}),
									...(filter ? { mailboxId: id(filter) } : {}),
								});
								pages.push(page);
								at = page.modseq;
								more = page.hasMore;
							}
							return pages;
						},
					);
				} else if (kind === 15) {
					const since = r.next() < 0.2 ? 0 : (r.pick(modseqs) as number);
					const limit = r.next() < 0.3 ? undefined : 1 + r.int(4);
					answer = await step(`mailboxChanges ${since} ${limit}`, (s, id) =>
						s.mailboxChanges(id(a), since, limit ? { limit } : {}),
					);
				} else if (kind === 16) {
					const target = box();
					const options = {
						...(r.next() < 0.3 ? { fromUid: r.int(6) } : {}),
						...(r.next() < 0.3 ? { changedSince: r.pick(modseqs) ?? 0 } : {}),
					};
					answer = await step('listMessages', (s, id) =>
						s.listMessages(id(a), id(target), options),
					);
				} else {
					const choice = r.int(4);
					const offset = r.int(4);
					const limit = 1 + r.int(4);
					const blob = r.next() < 0.8 ? r.pick(blobs) : 'f'.repeat(64);
					const target = box();
					const subscribe = r.next() < 0.5;
					answer = await step(`read ${choice}`, (s, id) =>
						choice === 0
							? s.listMailboxes(id(a))
							: choice === 1
								? s.listAccountMessages(id(a), { offset, limit })
								: choice === 2
									? s.readContent(id(a), blob ?? '')
									: s.setSubscribed(id(a), id(target), subscribe),
					);
				}
				collect(answer);
			}
			// A dense history ends with a sweep: one page of the changes since
			// every modseq the account gave, cut short or not, for the account
			// and each of its mailboxes — where a page is cut is where the
			// rules of the changes meet.
			if (dense) {
				const account = accounts[0] as string;
				const last = (
					await sides[0]?.store.messageChanges(
						(sides[0] as Side).names.id(account),
						0,
					)
				)?.modseq as number;
				const boxes = made
					.filter((m) => m.mailbox && m.live && m.account === account)
					.map((m) => m.name);
				for (let since = 0; since <= last; since++) {
					for (const limit of [1, 3]) {
						for (const filter of [undefined, ...boxes]) {
							await step(`sweep ${since} ${limit} ${filter}`, (s, id) =>
								s.messageChanges(id(account), since, {
									limit,
									...(filter ? { mailboxId: id(filter) } : {}),
								}),
							);
						}
						await step(`sweep mailboxes ${since} ${limit}`, (s, id) =>
							s.mailboxChanges(id(account), since, { limit }),
						);
					}
				}
			}
			// The end state, whole.
			for (const account of accounts) {
				await step('end: messages', (s, id) =>
					s.listAccountMessages(id(account)),
				);
				await step('end: mailboxes', (s, id) => s.listMailboxes(id(account)));
				await step('end: changes', (s, id) => s.messageChanges(id(account), 0));
			}
		});
	}
});
