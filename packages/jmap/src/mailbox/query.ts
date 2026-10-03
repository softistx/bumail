import type { Mailbox } from '@bumail/store';
import { type Args, accountOf, onlyKnown } from '../api/args';
import type { CallContext } from '../api/context';
import { invalidArguments, MethodError } from '../api/errors';
import { type Filter, filterOf, matches } from '../api/filter';
import { compareText, pageOf, sortOf } from '../api/query';
import { stateOf } from '../api/state';
import { quoted } from '../shared/text';

/** A Mailbox/query FilterCondition (RFC 8621 §2.3). */
interface Condition {
	readonly parentId?: string | null;
	readonly role?: string | null;
	readonly name?: string;
	readonly hasAnyRole?: boolean;
	readonly isSubscribed?: boolean;
}

function conditionOf(value: Record<string, unknown>): Condition {
	for (const [key, item] of Object.entries(value)) {
		const ok =
			((key === 'parentId' || key === 'role') &&
				(item === null || typeof item === 'string')) ||
			(key === 'name' && typeof item === 'string') ||
			((key === 'hasAnyRole' || key === 'isSubscribed') &&
				typeof item === 'boolean');
		if (!ok)
			throw new MethodError(
				'unsupportedFilter',
				`The filter ${quoted(key)} is not supported`,
			);
	}
	return value as Condition;
}

function test(condition: Condition, mailbox: Mailbox): boolean {
	const { parentId, role, name, hasAnyRole, isSubscribed } = condition;
	if (parentId !== undefined && (mailbox.parentId ?? null) !== parentId)
		return false;
	if (role !== undefined && (mailbox.role ?? null) !== role) return false;
	if (
		name !== undefined &&
		!mailbox.name.toLowerCase().includes(name.toLowerCase())
	)
		return false;
	if (hasAnyRole !== undefined && (mailbox.role !== undefined) !== hasAnyRole)
		return false;
	if (isSubscribed !== undefined && mailbox.isSubscribed !== isSubscribed)
		return false;
	return true;
}

/** Mailbox/query (RFC 8621 §2.3): every mailbox sorts with `sortOrder` 0, the store keeping none. */
export async function mailboxQuery(
	args: Args,
	ctx: CallContext,
): Promise<Args> {
	onlyKnown(args, [
		'accountId',
		'filter',
		'sort',
		'position',
		'anchor',
		'anchorOffset',
		'limit',
		'calculateTotal',
		'sortAsTree',
		'filterAsTree',
	]);
	const accountId = accountOf(args, ctx);
	if (args['sortAsTree'] === true || args['filterAsTree'] === true) {
		throw invalidArguments('sortAsTree and filterAsTree are not supported yet');
	}
	const filter: Filter<Condition> | undefined = filterOf(
		args['filter'],
		conditionOf,
	);
	const sort = sortOf(args['sort'], ['sortOrder', 'name']);
	const state = await stateOf(ctx.store, accountId);
	const mailboxes: Mailbox[] = [];
	for (const mailbox of await ctx.store.listMailboxes(accountId)) {
		if (await matches(filter, mailbox, test)) mailboxes.push(mailbox);
	}
	mailboxes.sort((a, b) => {
		for (const { property, isAscending } of sort) {
			const order = property === 'name' ? compareText(a.name, b.name) : 0;
			if (order !== 0) return isAscending ? order : -order;
		}
		return compareText(a.id, b.id);
	});
	const ids = mailboxes.map((mailbox) => mailbox.id);
	return {
		accountId,
		queryState: state,
		canCalculateChanges: false,
		...pageOf(ids, args, ctx.settings.limits.maxObjectsInGet),
	};
}
