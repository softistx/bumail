import type { MailboxEntry } from '@bumail/store';
import { lowerBound } from '../protocol/sequence';

/** What the session knows of one message of the selected mailbox. */
interface Known {
	readonly id: string;
	flags: readonly string[];
}

/**
 * The selected mailbox as the client sees it (RFC 9051 §2.3.1.2): its
 * messages in sequence-number order, which is UID order, and the flags
 * last told. A change made elsewhere reaches it only when the session
 * syncs, so the numbers the client holds stay valid between two
 * untagged responses.
 */
export class Selected {
	readonly mailboxId: string;
	readonly readOnly: boolean;
	readonly uidValidity: number;
	/** The store's modseq this view is in step with. */
	modseq: number;
	/** UIDs, ascending: the message at sequence number n has `uids[n - 1]`. */
	#uids: number[] = [];
	#known: Known[] = [];
	#byId = new Map<string, number>();

	constructor(
		mailbox: { id: string; uidValidity: number; highestModseq: number },
		entries: readonly MailboxEntry[],
		readOnly: boolean,
	) {
		this.mailboxId = mailbox.id;
		this.uidValidity = mailbox.uidValidity;
		this.modseq = mailbox.highestModseq;
		this.readOnly = readOnly;
		this.add(entries);
	}

	get count(): number {
		return this.#uids.length;
	}

	get uids(): readonly number[] {
		return this.#uids;
	}

	get lastUid(): number {
		return this.#uids[this.#uids.length - 1] ?? 0;
	}

	uidAt(position: number): number {
		return this.#uids[position] as number;
	}

	idAt(position: number): string {
		return (this.#known[position] as Known).id;
	}

	flagsAt(position: number): readonly string[] {
		return (this.#known[position] as Known).flags;
	}

	/** The 0-based position of a UID, or -1. */
	positionOf(uid: number): number {
		const at = lowerBound(this.#uids, uid);
		return this.#uids[at] === uid ? at : -1;
	}

	/** The UID a message has here, or `undefined`. */
	uidOf(messageId: string): number | undefined {
		return this.#byId.get(messageId);
	}

	/** Entries past the last UID, in UID order; others are ignored. */
	add(entries: readonly MailboxEntry[]): number {
		let added = 0;
		for (const { uid, message } of entries) {
			if (uid <= this.lastUid) continue;
			this.#uids.push(uid);
			this.#known.push({ id: message.id, flags: message.flags });
			this.#byId.set(message.id, uid);
			added++;
		}
		return added;
	}

	/** Records flags told to the client; `false` when they were already known. */
	setFlags(uid: number, flags: readonly string[]): boolean {
		const position = this.positionOf(uid);
		const known = this.#known[position];
		if (!known) return false;
		if (sameFlags(known.flags, flags)) return false;
		known.flags = flags;
		return true;
	}

	/**
	 * Removes messages by UID, and gives the sequence number each EXPUNGE
	 * response names, in order: each one counted after the ones before it
	 * left (RFC 9051 §7.5.1). One pass over the mailbox, whatever the count.
	 */
	expunge(uids: Iterable<number>): number[] {
		const gone = new Set(uids);
		const seqs: number[] = [];
		const keptUids: number[] = [];
		const keptKnown: Known[] = [];
		for (let i = 0; i < this.#uids.length; i++) {
			const uid = this.#uids[i] as number;
			const known = this.#known[i] as Known;
			if (gone.has(uid)) {
				seqs.push(keptUids.length + 1);
				this.#byId.delete(known.id);
			} else {
				keptUids.push(uid);
				keptKnown.push(known);
			}
		}
		this.#uids = keptUids;
		this.#known = keptKnown;
		return seqs;
	}
}

export function sameFlags(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((flag, i) => flag === b[i]);
}
