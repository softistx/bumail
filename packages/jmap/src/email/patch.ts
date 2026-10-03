import type { FlagChange, Message } from '@bumail/store';
import { type Args, idOf, isObject } from '../api/args';
import type { CallContext } from '../api/context';
import { type SetError, setError } from '../api/errors';
import { flagOf, isKeyword } from './keywords';

/** A set of keys changed whole, or one key at a time. */
interface KeyChange {
	set?: string[];
	readonly add: string[];
	readonly remove: string[];
}

/** What an Email/set update changes: keywords as flags, mailboxIds as ids. */
export interface EmailChange {
	readonly keywords?: KeyChange;
	readonly mailboxIds?: KeyChange;
}

const unescapeToken = (token: string) =>
	token.replaceAll('~1', '/').replaceAll('~0', '~');

/** `{ key: true }`'s keys, each read by `key`; `undefined` when it is not such an object. */
function keysOf(
	value: unknown,
	key: (raw: string) => string | undefined,
): string[] | undefined {
	if (!isObject(value) || Object.keys(value).length > 1000) return undefined;
	const keys: string[] = [];
	for (const [raw, flag] of Object.entries(value)) {
		const read = key(raw);
		if (flag !== true || read === undefined) return undefined;
		keys.push(read);
	}
	return keys;
}

function keyOf(
	property: 'keywords' | 'mailboxIds',
	raw: string,
	ctx: CallContext,
) {
	if (property === 'mailboxIds') return idOf(raw, ctx);
	return isKeyword(raw) ? flagOf(raw) : undefined;
}

/** An update's patch (RFC 8620 §5.3) as the changes it makes, or the SetError that refuses it. */
export function emailChangeOf(
	patch: Args,
	ctx: CallContext,
): EmailChange | SetError {
	const change: Record<string, KeyChange> = {};
	for (const [path, value] of Object.entries(patch)) {
		const [property = '', ...rest] = path.split('/');
		if (
			(property !== 'keywords' && property !== 'mailboxIds') ||
			rest.length > 1
		) {
			return setError(
				'invalidProperties',
				'Only keywords and mailboxIds can be changed',
				[property],
			);
		}
		const entry = change[property] ?? { add: [], remove: [] };
		change[property] = entry;
		if (rest.length === 0) {
			const keys = keysOf(value, (raw) => keyOf(property, raw, ctx));
			if (keys === undefined)
				return setError(
					'invalidProperties',
					`${property} is an object of keys set to true`,
					[property],
				);
			entry.set = keys;
		} else {
			const key = keyOf(property, unescapeToken(rest[0] as string), ctx);
			if (key === undefined || (value !== true && value !== null)) {
				return setError(
					'invalidPatch',
					`${path.slice(0, 100)} is not a key set to true or null`,
				);
			}
			(value === true ? entry.add : entry.remove).push(key);
		}
		if (entry.set !== undefined && entry.add.length + entry.remove.length > 0) {
			return setError(
				'invalidPatch',
				`${property} is patched whole and by key at once`,
			);
		}
	}
	return change;
}

/** The flags change a keywords change makes, keeping `\Deleted`, which JMAP does not show. */
export function flagChangeOf(change: KeyChange, message: Message): FlagChange {
	if (change.set === undefined)
		return { add: change.add, remove: change.remove };
	const kept = message.flags.filter((flag) => flag === '\\Deleted');
	return { set: [...change.set, ...kept] };
}

/** The mailboxes a message is to be in after a mailboxIds change. */
export function mailboxesAfter(
	change: KeyChange,
	message: Message,
): Set<string> {
	if (change.set !== undefined) return new Set(change.set);
	const after = new Set(message.mailboxes.map(({ mailboxId }) => mailboxId));
	for (const id of change.add) after.add(id);
	for (const id of change.remove) after.delete(id);
	return after;
}
