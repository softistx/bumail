import { QueueError } from '../errors';
import type { Collections, Names } from './connect';

/**
 * The migrations, in order: the layout document's `version` is how many
 * of them the queue has run. A migration is never edited once released;
 * a change is a new one at the end. Each is safe to run twice, and while
 * another instance runs it: creating an index that exists is no change.
 */
export const MIGRATIONS: readonly ((c: Collections) => Promise<unknown>)[] = [
	// 1: the claim's order, and its range: the earliest due first, then the
	// oldest; and the places `maxItems` hands out, one item each.
	async ({ items }) => {
		await items.createIndex(
			{ nextAttemptAt: 1, seq: 1 },
			{ name: 'bumail_due' },
		);
		await items.createIndex(
			{ slot: 1 },
			{
				name: 'bumail_slot',
				unique: true,
				partialFilterExpression: { slot: { $exists: true } },
			},
		);
	},
];

/** The layout this store writes; a newer one is refused. */
export const LAYOUT = MIGRATIONS.length;

/** The `_id` of the document that holds the layout version, in the schema collection. */
export const LAYOUT_ID = 'layout';

function checkVersion(version: unknown, names: Names): number {
	if (
		typeof version !== 'number' ||
		!Number.isInteger(version) ||
		version < 1
	) {
		throw new QueueError(
			'INVALID',
			`The collection ${names.schema} does not hold a layout version: is the prefix another application's?`,
		);
	}
	if (version > LAYOUT) {
		throw new QueueError(
			'INVALID',
			`The database is at schema version ${version}, newer than this store's ${LAYOUT}`,
		);
	}
	return version;
}

/**
 * Reads the layout version and, on a queue behind it — a new one
 * included — runs the migrations it lacks, then writes it. A queue
 * already current is only read: a user who may not create an index runs
 * it once another made it.
 */
export async function checkLayout(
	collections: Collections,
	names: Names,
): Promise<void> {
	const { schema } = collections;
	const found = await schema.findOne({ _id: LAYOUT_ID });
	const version = found ? checkVersion(found['version'], names) : 0;
	if (version === LAYOUT) return;
	for (const migration of MIGRATIONS.slice(version)) {
		await migration(collections);
	}
	// `$max`: an instance that finished a later migration first is not undone.
	const written = await schema.findOneAndUpdate(
		{ _id: LAYOUT_ID },
		{ $max: { version: LAYOUT } },
		{ upsert: true, returnDocument: 'after' },
	);
	checkVersion(written?.['version'], names);
}
