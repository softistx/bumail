import type { MailboxEntry } from '@bumail/store';
import { Response } from '../protocol/response';
import type { Connection } from '../server/connection';
import type { Selected } from './selected';

/** How many changes one call to the store returns. */
const PAGE = 1000;

/** `(\Seen \Flagged)`: flags as a FETCH response or FLAGS lists them. */
export function flagList(flags: readonly string[]): string {
	return `(${flags.join(' ')})`;
}

function isCannotCalculate(error: unknown): boolean {
	return (
		(error as { code?: unknown } | null)?.code === 'CANNOT_CALCULATE_CHANGES'
	);
}

/** The UIDs that left the mailbox since `since`, or `undefined` when the store no longer remembers. */
async function expungedSince(
	connection: Connection,
	view: Selected,
	since: number,
): Promise<Set<number> | undefined> {
	const { store } = connection.settings;
	const gone = new Set<number>();
	try {
		for (let from = since; ; ) {
			const changes = await store.messageChanges(connection.accountId, from, {
				mailboxId: view.mailboxId,
				limit: PAGE,
			});
			for (const entry of changes.expunged) gone.add(entry.uid);
			if (!changes.hasMore || changes.modseq <= from) return gone;
			from = changes.modseq;
		}
	} catch (error) {
		if (isCannotCalculate(error)) return undefined;
		throw error;
	}
}

/** Every UID the view holds that the mailbox no longer does. */
function missing(
	view: Selected,
	entries: readonly MailboxEntry[],
): Set<number> {
	const present = new Set(entries.map((entry) => entry.uid));
	return new Set(view.uids.filter((uid) => !present.has(uid)));
}

async function tellFlags(
	connection: Connection,
	view: Selected,
	entries: readonly MailboxEntry[],
): Promise<void> {
	for (const { uid, message } of entries) {
		if (!view.setFlags(uid, message.flags)) continue;
		const seq = view.positionOf(uid) + 1;
		const line = new Response().text(
			`* ${seq} FETCH (UID ${uid} FLAGS ${flagList(message.flags)})`,
		);
		await connection.send(line.done());
	}
}

/**
 * Tells the client what changed in the selected mailbox since it last
 * heard (RFC 9051 §7.5): EXPUNGE for each message gone, EXISTS when some
 * came, and FETCH FLAGS for flags changed elsewhere. One look at the
 * mailbox when nothing changed; the changes since the last modseq when
 * something did; the whole mailbox when the store no longer remembers that
 * far. A mailbox deleted meanwhile ends the session with BYE.
 *
 * Called where RFC 9051 lets EXPUNGE be sent: NOOP, IDLE, and the commands
 * that may change the mailbox — never FETCH, STORE or SEARCH.
 */
export async function sync(connection: Connection): Promise<void> {
	const view = connection.state.selected;
	if (!view) return;
	const { store } = connection.settings;
	const accountId = connection.accountId;
	const mailbox = await store.getMailbox(accountId, view.mailboxId);
	if (!mailbox) {
		return connection.close('The selected mailbox was deleted, closing');
	}
	if (mailbox.highestModseq === view.modseq) return;
	let gone = await expungedSince(connection, view, view.modseq);
	const changed = gone
		? await store.listMessages(accountId, view.mailboxId, {
				changedSince: view.modseq,
			})
		: await store.listMessages(accountId, view.mailboxId);
	gone ??= missing(view, changed);
	const present = gone.size > 0 ? view.uids.filter((uid) => gone.has(uid)) : [];
	for (const seq of view.expunge(present))
		await connection.untagged(`${seq} EXPUNGE`);
	const before = view.count;
	view.add(changed);
	if (view.count !== before) await connection.untagged(`${view.count} EXISTS`);
	await tellFlags(connection, view, changed);
	view.modseq = mailbox.highestModseq;
}
