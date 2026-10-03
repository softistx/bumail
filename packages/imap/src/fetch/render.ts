import type { Message } from '@bumail/store';
import type { Selected } from '../mailbox/selected';
import { flagList } from '../mailbox/sync';
import { bodyStructure } from '../message/bodystructure';
import { EMPTY_ENVELOPE, envelope } from '../message/envelope';
import { sectionName } from '../message/section';
import { formatDateTime } from '../protocol/dates';
import { type Piece, Response } from '../protocol/response';
import type { Connection } from '../server/connection';
import { MessageContent, partOf } from './content';
import type { FetchItem } from './items';

/** What to send of one message: its place, the message, and the items. */
export interface FetchTarget {
	readonly seq: number;
	readonly uid: number;
	readonly message: Message;
	readonly items: readonly FetchItem[];
}

async function sectionItem(
	out: Response,
	content: MessageContent,
	item: Extract<FetchItem, { kind: 'section' }>,
): Promise<void> {
	const origin = item.partial ? `<${item.partial.origin}>` : '';
	out.text(`${item.legacy ?? `BODY[${sectionName(item.section)}]${origin}`} `);
	const data = await content.section(item.section);
	if (data === undefined) out.text('NIL');
	else out.literal(partOf(data, item.partial));
}

async function renderItem(
	out: Response,
	content: MessageContent,
	target: FetchTarget,
	item: FetchItem,
): Promise<void> {
	const { message } = target;
	switch (item.kind) {
		case 'UID':
			out.text(`UID ${target.uid}`);
			return;
		case 'FLAGS':
			out.text(`FLAGS ${flagList(message.flags)}`);
			return;
		case 'INTERNALDATE':
			out.text(`INTERNALDATE ${formatDateTime(message.receivedAt)}`);
			return;
		case 'RFC822.SIZE':
			out.text(`RFC822.SIZE ${message.size}`);
			return;
		case 'ENVELOPE': {
			out.text('ENVELOPE ');
			const root = await content.header();
			if (root) envelope(out, root.headers);
			else out.text(EMPTY_ENVELOPE);
			return;
		}
		case 'BODY':
		case 'BODYSTRUCTURE': {
			out.text(`${item.kind} `);
			const root = await content.structure();
			if (root) bodyStructure(out, root, item.kind === 'BODYSTRUCTURE');
			else out.text('("text" "plain" NIL NIL NIL "7BIT" 0 0)');
			return;
		}
		default:
			return sectionItem(out, content, item);
	}
}

/**
 * One FETCH response (RFC 9051 §7.5.2): `* seq FETCH (…)`, the items in the
 * order asked. Literals are Blobs sliced from the message, read only as
 * the response is sent. The flags sent are recorded in the view, so a
 * later sync does not tell them again.
 */
export async function renderFetch(
	connection: Connection,
	view: Selected,
	target: FetchTarget,
): Promise<Piece[]> {
	const content = new MessageContent(connection, target.message);
	const out = new Response().text(`* ${target.seq} FETCH (`);
	let first = true;
	for (const item of target.items) {
		if (!first) out.text(' ');
		first = false;
		await renderItem(out, content, target, item);
		if (item.kind === 'FLAGS') view.setFlags(target.uid, target.message.flags);
	}
	return out.text(')').done();
}
