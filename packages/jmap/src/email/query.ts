import { type Message, StoreError } from '@bumail/store';
import { type Args, accountOf, boolOf, onlyKnown } from '../api/args';
import type { CallContext } from '../api/context';
import { MethodError } from '../api/errors';
import { type Filter, filterOf, matches } from '../api/filter';
import { type Comparator, compareText, pageOf, sortOf } from '../api/query';
import { stateOf } from '../api/state';
import { type Condition, conditionOf, test } from './filter';
import { parsed } from './headers';
import { Candidate, type ReadBudget } from './search';

/** The sorts Email/query takes, announced in the session as `emailQuerySortOptions`. */
export const EMAIL_SORTS = ['receivedAt', 'size', 'from', 'to', 'subject'];

const DEFAULT_SORT: Comparator[] = [
	{ property: 'receivedAt', isAscending: false },
];

/** The mailbox a filter keeps every result in, when it names one at its top. */
function mailboxOf(filter: Filter<Condition> | undefined): string | undefined {
	if (filter === undefined) return undefined;
	if ('condition' in filter)
		return filter.condition['inMailbox'] as string | undefined;
	if (filter.operator !== 'AND') return undefined;
	for (const child of filter.conditions) {
		const found = mailboxOf(child);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The emails a query looks at: one mailbox's, or the account's; never more than `maxQueryScan`. */
async function candidatesOf(
	filter: Filter<Condition> | undefined,
	ctx: CallContext,
): Promise<readonly Message[]> {
	const max = ctx.settings.limits.maxQueryScan;
	const tooLarge = () =>
		new MethodError(
			'tooLarge',
			`The query would read more than ${max} emails: the store has no index yet`,
		);
	const mailboxId = mailboxOf(filter);
	if (mailboxId !== undefined) {
		try {
			const entries = await ctx.store.listMessages(ctx.accountId, mailboxId);
			if (entries.length > max) throw tooLarge();
			return entries.map(({ message }) => message);
		} catch (error) {
			if (error instanceof StoreError && error.code === 'NOT_FOUND') return [];
			throw error;
		}
	}
	const page = await ctx.store.listAccountMessages(ctx.accountId, {
		limit: max,
	});
	if (page.total > max) throw tooLarge();
	return page.messages;
}

/** The first address's name, or its address: what RFC 8621 §4.4.2 sorts `from` and `to` by. */
async function addressKey(candidate: Candidate, name: string): Promise<string> {
	const value = (await candidate.headers()).getAll(name).at(-1);
	const [first] =
		value === undefined
			? []
			: (parsed(value, 'asAddresses') as {
					name: string | null;
					email: string;
				}[]);
	return first === undefined ? '' : (first.name ?? first.email);
}

/** The subject without its `Re:` and `Fwd:` prefixes. */
async function subjectKey(candidate: Candidate): Promise<string> {
	let subject = await candidate.header('Subject');
	for (let previous = ''; previous !== subject; ) {
		previous = subject;
		subject = subject
			.trimStart()
			.replace(/^(?:re|fwd?|aw|sv)(?:\[\d{1,5}\])?:/i, '');
	}
	return subject.trim();
}

async function sortKeys(
	candidate: Candidate,
	sort: readonly Comparator[],
): Promise<(string | number)[]> {
	const keys: (string | number)[] = [];
	for (const { property } of sort) {
		if (property === 'receivedAt')
			keys.push(candidate.message.receivedAt.getTime());
		else if (property === 'size') keys.push(candidate.message.size);
		else if (property === 'subject') keys.push(await subjectKey(candidate));
		else
			keys.push(
				await addressKey(candidate, property === 'from' ? 'From' : 'To'),
			);
	}
	return keys;
}

function compareKeys(
	a: (string | number)[],
	b: (string | number)[],
	sort: readonly Comparator[],
): number {
	for (const [i, { isAscending }] of sort.entries()) {
		const x = a[i] as string | number;
		const y = b[i] as string | number;
		const order =
			typeof x === 'number' ? x - (y as number) : compareText(x, y as string);
		if (order !== 0) return isAscending ? order : -order;
	}
	return 0;
}

/** Email/query (RFC 8621 §4.4), in memory: every candidate read, filtered and sorted here. */
export async function emailQuery(args: Args, ctx: CallContext): Promise<Args> {
	onlyKnown(args, [
		'accountId',
		'filter',
		'sort',
		'position',
		'anchor',
		'anchorOffset',
		'limit',
		'calculateTotal',
		'collapseThreads',
	]);
	const accountId = accountOf(args, ctx);
	const filter = filterOf(args['filter'], (condition) =>
		conditionOf(condition, ctx),
	);
	const given = sortOf(args['sort'], EMAIL_SORTS);
	const sort = given.length === 0 ? DEFAULT_SORT : given;
	const collapse = boolOf(args, 'collapseThreads');
	const state = await stateOf(ctx.store, accountId);
	const budget: ReadBudget = { left: ctx.settings.limits.maxQueryScan };
	const found: { candidate: Candidate; keys: (string | number)[] }[] = [];
	for (const message of await candidatesOf(filter, ctx)) {
		const candidate = new Candidate(message, ctx, budget);
		if (await matches(filter, candidate, test)) {
			found.push({ candidate, keys: await sortKeys(candidate, sort) });
		}
	}
	found.sort(
		(a, b) =>
			compareKeys(a.keys, b.keys, sort) ||
			compareText(a.candidate.message.id, b.candidate.message.id),
	);
	const threads = new Set<string>();
	const ids: string[] = [];
	for (const {
		candidate: { message },
	} of found) {
		if (collapse && threads.has(message.threadId)) continue;
		threads.add(message.threadId);
		ids.push(message.id);
	}
	return {
		accountId,
		queryState: state,
		canCalculateChanges: false,
		collapseThreads: collapse,
		...pageOf(ids, args, ctx.settings.limits.maxObjectsInGet),
	};
}
