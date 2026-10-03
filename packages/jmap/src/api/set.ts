import { StoreError } from '@bumail/store';
import { cut, isId, quoted } from '../shared/text';
import { type Args, idOf, isObject } from './args';
import type { CallContext } from './context';
import {
	invalidArguments,
	MethodError,
	type SetError,
	setError,
} from './errors';

/** A `/set`'s creates, updates and destroys (RFC 8620 §5.3), checked. */
export interface SetPlan {
	readonly create: readonly (readonly [string, Args])[];
	readonly update: readonly (readonly [string, Args])[];
	readonly destroy: readonly string[];
}

/** What a `/set` did, to answer. */
export class SetResult {
	readonly created: Record<string, Args> = {};
	readonly notCreated: Record<string, SetError> = {};
	readonly updated: Record<string, Args | null> = {};
	readonly notUpdated: Record<string, SetError> = {};
	readonly destroyed: string[] = [];
	readonly notDestroyed: Record<string, SetError> = {};

	/** The response's arguments: each map `null` when it is empty. */
	toArgs(accountId: string, oldState: string, newState: string): Args {
		const orNull = (value: object) =>
			Object.keys(value).length === 0 ? null : value;
		return {
			accountId,
			oldState,
			newState,
			created: orNull(this.created),
			updated: orNull(this.updated),
			destroyed: this.destroyed.length === 0 ? null : this.destroyed,
			notCreated: orNull(this.notCreated),
			notUpdated: orNull(this.notUpdated),
			notDestroyed: orNull(this.notDestroyed),
		};
	}
}

function entriesOf(value: unknown, name: string): [string, Args][] {
	if (value === undefined || value === null) return [];
	if (!isObject(value)) throw invalidArguments(`${name} must be an object`);
	return Object.entries(value).map(([key, item]) => {
		if (!isObject(item))
			throw invalidArguments(`${name}[${quoted(key)}] must be an object`);
		return [key, item];
	});
}

/** The `create`, `update` and `destroy` arguments, at most `max` together. */
export function setPlanOf(args: Args, ctx: CallContext, max: number): SetPlan {
	const create = entriesOf(args['create'], 'create');
	for (const [creationId] of create) {
		if (!isId(creationId))
			throw invalidArguments(
				`create has ${quoted(creationId)}, which is not a creation id`,
			);
	}
	const update = entriesOf(args['update'], 'update').map(
		([id, patch]) => [idOf(id, ctx) ?? id, patch] as const,
	);
	const given = args['destroy'];
	if (given !== undefined && given !== null && !Array.isArray(given)) {
		throw invalidArguments('destroy must be an array of ids');
	}
	const destroy = ((given ?? []) as unknown[]).map((id) => {
		if (typeof id !== 'string')
			throw invalidArguments('destroy must be an array of ids');
		return idOf(id, ctx) ?? id;
	});
	if (create.length + update.length + destroy.length > max) {
		throw new MethodError(
			'requestTooLarge',
			`The call creates, updates and destroys more than ${max} objects`,
		);
	}
	return { create, update, destroy };
}

/** A store's refusal of one object as a SetError, `property` naming what it refused. */
export function storeSetError(error: unknown, property?: string): SetError {
	if (!(error instanceof StoreError)) throw error;
	const properties = property === undefined ? undefined : [property];
	const description = cut(error.message, 200);
	switch (error.code) {
		case 'NOT_FOUND':
			return property === undefined
				? setError('notFound')
				: setError('invalidProperties', description, properties);
		case 'ALREADY_EXISTS':
		case 'INVALID':
			return setError('invalidProperties', description, properties);
		default:
			throw error;
	}
}
