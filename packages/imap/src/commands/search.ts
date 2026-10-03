import { loadMessages } from '../mailbox/lookup';
import type { Selected } from '../mailbox/selected';
import type { Cursor } from '../protocol/cursor';
import { quoted } from '../protocol/response';
import { formatSequenceSet } from '../protocol/sequence';
import { searchKeys } from '../search/keys';
import { search } from '../search/match';
import { type Command, type Context, no, ok, SELECTED } from './context';

const RETURNS = new Set(['MIN', 'MAX', 'ALL', 'COUNT']);

/** `RETURN (…)` (RFC 4731, RFC 9051 §6.4.4): what ESEARCH gives; `()` means ALL. SAVE is not supported. */
function returnOptions(cursor: Cursor): Set<string> | undefined {
	if (cursor.peekWord().toUpperCase() !== 'RETURN') return undefined;
	cursor.itemName();
	cursor.sp();
	const options = new Set(
		cursor.list((c) => c.atom('a return option').toUpperCase()),
	);
	for (const option of options) {
		if (!RETURNS.has(option))
			cursor.fail(`Unsupported SEARCH return option ${option}`);
	}
	cursor.sp();
	return options.size === 0 ? new Set(['ALL']) : options;
}

/** `CHARSET`: UTF-8 and US-ASCII are what the server compares in. */
function charsetOk(cursor: Cursor): boolean {
	if (cursor.peekWord().toUpperCase() !== 'CHARSET') return true;
	cursor.itemName();
	cursor.sp();
	const charset = cursor.astring().toUpperCase();
	cursor.sp();
	return charset === 'UTF-8' || charset === 'US-ASCII';
}

/** `* ESEARCH (TAG "x") [UID] …`. */
function esearch(
	context: Context,
	numbers: readonly number[],
	options: Set<string>,
): string {
	const parts = [`ESEARCH (TAG ${quoted(context.tag)})`];
	if (context.uid) parts.push('UID');
	if (options.has('MIN') && numbers.length > 0) parts.push(`MIN ${numbers[0]}`);
	if (options.has('MAX') && numbers.length > 0)
		parts.push(`MAX ${numbers[numbers.length - 1]}`);
	if (options.has('ALL') && numbers.length > 0)
		parts.push(`ALL ${formatSequenceSet(numbers)}`);
	if (options.has('COUNT')) parts.push(`COUNT ${numbers.length}`);
	return parts.join(' ');
}

/**
 * SEARCH and UID SEARCH (RFC 9051 §6.4.4). An IMAP4rev1 session gets
 * `* SEARCH`, unless it asked RETURN; an IMAP4rev2 one gets `* ESEARCH`.
 * TEXT and BODY compare the bytes as stored, without case for ASCII:
 * a base64 or quoted-printable body is not decoded first.
 */
export const SEARCH: Command = {
	phases: SELECTED,
	async run(context) {
		const { connection, cursor, uid } = context;
		const view = connection.state.selected as Selected;
		const options = returnOptions(cursor);
		if (!charsetOk(cursor)) {
			return no(context, '[BADCHARSET (UTF-8 US-ASCII)] Unsupported charset');
		}
		const key = searchKeys(cursor);
		const all = view.uids.map((_, position) => position);
		const loaded = await loadMessages(connection, view, all);
		const positions = await search(connection, view, key, loaded);
		const numbers = positions.map((position) =>
			uid ? view.uidAt(position) : position + 1,
		);
		if (options || connection.state.rev2) {
			await connection.untagged(
				esearch(context, numbers, options ?? new Set(['ALL'])),
			);
		} else {
			await connection.untagged(['SEARCH', ...numbers].join(' '));
		}
		await ok(context, `${uid ? 'UID ' : ''}SEARCH completed`);
	},
};
