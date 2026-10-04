import type { CheckContext } from './check';
import type { Checker, Table } from './checker';
import { refuseInsecure } from './credentials';
import type { Env, Overrides } from './env';
import { type CheckedStoreUrl, checkStoreUrl } from './urls';

/** Where the server keeps its data, as configured: each `undefined` for the default under `data`. */
export interface CheckedStorage {
	readonly store: CheckedStoreUrl | undefined;
	readonly queue: CheckedStoreUrl | undefined;
	readonly directory: CheckedStoreUrl | undefined;
}

/**
 * `[store]` (SQLite or PostgreSQL), `[queue]` (those, or Redis) and
 * `[directory]` (SQLite), the environment's URLs winning for the first
 * two.
 */
export function checkStorage(
	checker: Checker,
	root: Table,
	context: Pick<CheckContext, 'env' | 'overrides'>,
): CheckedStorage {
	const { env, overrides } = context;
	return {
		store: checkUrlSection(checker, root, env, 'store', overrides.storeUrl, [
			'sqlite',
			'postgres',
			'postgresql',
		]),
		queue: checkUrlSection(checker, root, env, 'queue', overrides.queueUrl, [
			'sqlite',
			'postgres',
			'postgresql',
			'redis',
			'rediss',
		]),
		directory: checkUrlSection(checker, root, env, 'directory', undefined, [
			'sqlite',
		]),
	};
}

/**
 * `[store]`, `[queue]` or `[directory]`: a `url`, the environment's
 * winning, and for the first two `insecure`, which lets a `redis:` URL
 * send its credentials in clear.
 */
function checkUrlSection(
	checker: Checker,
	root: Table,
	env: Env,
	section: string,
	override: Overrides['storeUrl'],
	schemes: readonly string[],
): CheckedStoreUrl | undefined {
	const keys = section === 'directory' ? ['url'] : ['url', 'insecure'];
	const table = checker.table(root[section], section, keys);
	const fromFile = checker.string(table, 'url', section);
	const context = {
		insecure:
			section === 'directory'
				? undefined
				: checker.boolean(table, 'insecure', section),
		insecurePath: `${section}.insecure`,
		env,
	};
	if (override !== undefined) {
		return checkStoreUrl(
			checker,
			override.value,
			`${section}.url (${override.from})`,
			schemes,
			context,
		);
	}
	if (fromFile === undefined) {
		// The default is SQLite, where `insecure` means nothing.
		refuseInsecure(checker, context);
		return undefined;
	}
	return checkStoreUrl(checker, fromFile, `${section}.url`, schemes, context);
}
