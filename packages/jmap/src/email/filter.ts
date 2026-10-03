import { type Args, idOf } from '../api/args';
import type { CallContext } from '../api/context';
import { MethodError } from '../api/errors';
import { quoted } from '../shared/text';
import { flagOf, hasFlag, isKeyword } from './keywords';
import { type Candidate, contains } from './search';

/** An Email/query FilterCondition (RFC 8621 §4.4.1), checked: dates as ms, keywords as flags. */
export interface Condition {
	readonly inMailbox?: string;
	readonly inMailboxOtherThan?: readonly string[];
	readonly before?: number;
	readonly after?: number;
	readonly minSize?: number;
	readonly maxSize?: number;
	readonly hasKeyword?: string;
	readonly notKeyword?: string;
	readonly text?: string;
	readonly from?: string;
	readonly to?: string;
	readonly cc?: string;
	readonly bcc?: string;
	readonly subject?: string;
	readonly body?: string;
}

const TEXT = ['text', 'from', 'to', 'cc', 'bcc', 'subject', 'body'];
const DATE = ['before', 'after'];
const SIZE = ['minSize', 'maxSize'];
const KEYWORD = ['hasKeyword', 'notKeyword'];

const unsupported = (key: string) =>
	new MethodError(
		'unsupportedFilter',
		`The filter ${quoted(key)} is not supported`,
	);

/** A condition's values checked: ids resolved, dates parsed, keywords mapped to flags. */
export function conditionOf(value: Args, ctx: CallContext): Condition {
	const condition: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === 'inMailbox') {
			condition[key] = idOf(item, ctx) ?? '';
		} else if (
			key === 'inMailboxOtherThan' &&
			Array.isArray(item) &&
			item.length <= 256
		) {
			condition[key] = item.map((id) => idOf(id, ctx) ?? '');
		} else if (
			DATE.includes(key) &&
			typeof item === 'string' &&
			!Number.isNaN(Date.parse(item))
		) {
			condition[key] = Date.parse(item);
		} else if (
			SIZE.includes(key) &&
			Number.isSafeInteger(item) &&
			(item as number) >= 0
		) {
			condition[key] = item;
		} else if (KEYWORD.includes(key) && isKeyword(item)) {
			condition[key] = flagOf(item);
		} else if (
			TEXT.includes(key) &&
			typeof item === 'string' &&
			item.length <= 1024
		) {
			condition[key] = item;
		} else {
			throw unsupported(key);
		}
	}
	return condition as Condition;
}

async function textMatches(
	key: string,
	needle: string,
	candidate: Candidate,
): Promise<boolean> {
	switch (key) {
		case 'from':
			return contains(await candidate.header('From'), needle);
		case 'to':
			return contains(await candidate.header('To'), needle);
		case 'cc':
			return contains(await candidate.header('Cc'), needle);
		case 'bcc':
			return contains(await candidate.header('Bcc'), needle);
		case 'subject':
			return contains(await candidate.header('Subject'), needle);
		case 'body':
			return contains(await candidate.text(), needle);
		default: {
			for (const name of ['From', 'To', 'Cc', 'Bcc', 'Subject']) {
				if (contains(await candidate.header(name), needle)) return true;
			}
			return contains(await candidate.text(), needle);
		}
	}
}

/** Whether an email matches every part of one condition, the cheap parts first. */
export async function test(
	condition: Condition,
	candidate: Candidate,
): Promise<boolean> {
	const { message } = candidate;
	const time = message.receivedAt.getTime();
	const mailboxes = message.mailboxes.map(({ mailboxId }) => mailboxId);
	const c = condition;
	if (c.inMailbox !== undefined && !mailboxes.includes(c.inMailbox))
		return false;
	const others = c.inMailboxOtherThan;
	if (others !== undefined && !mailboxes.some((id) => !others.includes(id)))
		return false;
	if (c.before !== undefined && !(time < c.before)) return false;
	if (c.after !== undefined && !(time >= c.after)) return false;
	if (c.minSize !== undefined && message.size < c.minSize) return false;
	if (c.maxSize !== undefined && message.size >= c.maxSize) return false;
	if (c.hasKeyword !== undefined && !hasFlag(message.flags, c.hasKeyword))
		return false;
	if (c.notKeyword !== undefined && hasFlag(message.flags, c.notKeyword))
		return false;
	for (const key of TEXT) {
		const needle = c[key as keyof Condition] as string | undefined;
		if (needle !== undefined && !(await textMatches(key, needle, candidate)))
			return false;
	}
	return true;
}
