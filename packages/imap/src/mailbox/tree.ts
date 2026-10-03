import type { Mailbox } from '@bumail/store';
import { SyntaxProblem } from '../protocol/cursor';
import { echo } from '../protocol/echo';
import { decodeUtf7, encodeUtf7 } from '../protocol/utf7';
import type { Connection } from '../server/connection';

/** The hierarchy delimiter: the store keeps `/` out of mailbox names for it. */
export const DELIMITER = '/';

/** `INBOX` at the top, whatever case the client wrote it in (RFC 9051 §5.1). */
export function canonical(path: string): string {
	const slash = path.indexOf(DELIMITER);
	const head = slash < 0 ? path : path.slice(0, slash);
	return head.toUpperCase() === 'INBOX'
		? `INBOX${path.slice(head.length)}`
		: path;
}

/**
 * A mailbox name as the client wrote it, to the name the store knows:
 * modified UTF-7 decoded for an IMAP4rev1 session (UTF-8 as it is after
 * ENABLE IMAP4rev2), `INBOX` canonical. A name that does not decode is BAD.
 */
export function nameFromClient(connection: Connection, raw: string): string {
	const name = connection.state.rev2 ? raw : decodeUtf7(raw);
	if (name === undefined) {
		throw new SyntaxProblem(
			`"${echo(raw)}" is not a valid modified UTF-7 mailbox name`,
		);
	}
	return canonical(name);
}

/** A mailbox name as the client reads it: modified UTF-7 unless IMAP4rev2. */
export function nameForClient(connection: Connection, name: string): string {
	return connection.state.rev2 ? name : encodeUtf7(name);
}

/** The account's mailboxes as IMAP names them: each one's path from the top. */
export class Tree {
	readonly #byPath = new Map<string, Mailbox>();
	readonly #paths = new Map<string, string>();
	readonly #children = new Map<string, number>();
	readonly mailboxes: readonly Mailbox[];

	constructor(mailboxes: readonly Mailbox[]) {
		this.mailboxes = mailboxes;
		const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
		const pathOf = (mailbox: Mailbox, depth = 0): string => {
			const known = this.#paths.get(mailbox.id);
			if (known !== undefined) return known;
			const parent =
				mailbox.parentId === undefined ? undefined : byId.get(mailbox.parentId);
			// The store refuses cycles; the depth check only keeps a broken one finite.
			const path =
				parent && depth < 256
					? `${pathOf(parent, depth + 1)}${DELIMITER}${mailbox.name}`
					: mailbox.name;
			this.#paths.set(mailbox.id, path);
			return path;
		};
		for (const mailbox of mailboxes) {
			this.#byPath.set(canonical(pathOf(mailbox)), mailbox);
			if (mailbox.parentId !== undefined) {
				this.#children.set(
					mailbox.parentId,
					(this.#children.get(mailbox.parentId) ?? 0) + 1,
				);
			}
		}
	}

	static async load(connection: Connection): Promise<Tree> {
		return new Tree(
			await connection.settings.store.listMailboxes(connection.accountId),
		);
	}

	find(path: string): Mailbox | undefined {
		return this.#byPath.get(canonical(path));
	}

	pathOf(mailbox: Mailbox): string {
		return this.#paths.get(mailbox.id) ?? mailbox.name;
	}

	hasChildren(mailbox: Mailbox): boolean {
		return (this.#children.get(mailbox.id) ?? 0) > 0;
	}

	/** Every mailbox inside this one, at any depth. */
	descendants(mailbox: Mailbox): Mailbox[] {
		const prefix = `${this.pathOf(mailbox)}${DELIMITER}`;
		return this.mailboxes.filter((other) =>
			this.pathOf(other).startsWith(prefix),
		);
	}
}

/** The special-use attribute of a role (RFC 6154, RFC 8457); the inbox has none. */
export function specialUse(mailbox: Mailbox): string | undefined {
	switch (mailbox.role) {
		case 'all':
			return '\\All';
		case 'archive':
			return '\\Archive';
		case 'drafts':
			return '\\Drafts';
		case 'flagged':
			return '\\Flagged';
		case 'important':
			return '\\Important';
		case 'junk':
			return '\\Junk';
		case 'sent':
			return '\\Sent';
		case 'trash':
			return '\\Trash';
		default:
			return undefined;
	}
}
