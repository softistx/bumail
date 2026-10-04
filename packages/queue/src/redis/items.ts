import { isDone } from '../contract/checks';
import type { QueueItem, RecipientState } from '../contract/types';

/** An item's hash, as `HGETALL` gives it: a map, or a script's flat list of names and values. */
export type Fields = Readonly<Record<string, string>>;

/** A script's `HGETALL`, `[name, value, …]`, as a map; a map as it is. */
export function fieldsOf(reply: unknown): Fields | undefined {
	if (Array.isArray(reply)) {
		const fields: Record<string, string> = {};
		for (let i = 0; i + 1 < reply.length; i += 2) {
			fields[String(reply[i])] = String(reply[i + 1]);
		}
		return fieldsOf(fields);
	}
	if (typeof reply !== 'object' || reply === null) return undefined;
	// No id: no item, whatever else a hash left half written holds.
	return (reply as Fields)['id'] === undefined ? undefined : (reply as Fields);
}

const field = (fields: Fields, name: string): string => fields[name] ?? '';

/** The item a hash holds. Times are kept as JavaScript wrote them, so each reads back exactly. */
export function itemOf(fields: Fields): QueueItem {
	const item: QueueItem = {
		id: field(fields, 'id'),
		from: field(fields, 'from'),
		recipients: JSON.parse(field(fields, 'recipients')) as RecipientState[],
		size: Number(field(fields, 'size')),
		createdAt: Number(field(fields, 'created')),
		nextAttemptAt: Number(field(fields, 'next')),
		attempts: Number(field(fields, 'attempts')),
		delayNotified: field(fields, 'delay') === '1',
	};
	const owner = fields['owner'];
	const expires = fields['expires'];
	if (owner === undefined || expires === undefined) return item;
	return { ...item, lease: { owner, expiresAt: Number(expires) } };
}

/**
 * The ids a store makes, `crypto.randomUUID()`'s. Any other id is one no
 * item has, so no id a caller gives ever reaches a key but an item's.
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isId = (id: unknown): id is string =>
	typeof id === 'string' && ID.test(id);

/** A time as a script takes it: the string JavaScript writes, which reads back exactly. */
export const time = (value: number) => String(value);

/** What `COMPLETE` records of an attempt: the item dropped, or its new state. */
export const outcomeOf = (item: QueueItem): string[] =>
	isDone(item)
		? ['drop']
		: [
				'record',
				JSON.stringify(item.recipients),
				time(item.nextAttemptAt),
				`${item.attempts}`,
				item.delayNotified ? '1' : '0',
			];
