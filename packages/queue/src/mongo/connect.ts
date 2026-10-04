import { invalid } from '../errors';
import { masked } from '../masked';
import type {
	MongoQueueCollection,
	MongoQueueCollectionOptions,
	MongoQueueDb,
	MongoQueueStoreOptions,
} from './options';

/** The collections of one queue, each name its prefix and a fixed suffix. */
export interface Names {
	readonly prefix: string;
	/** One document per item. */
	readonly items: string;
	/** Each message in chunks, a document each. */
	readonly messages: string;
	/** The layout version and the counter that orders items equally due. */
	readonly schema: string;
}

export interface Collections {
	readonly items: MongoQueueCollection;
	readonly messages: MongoQueueCollection;
	readonly schema: MongoQueueCollection;
}

/** The collections a store uses, and what to mask in the reasons it repeats. */
export interface Connection {
	readonly names: Names;
	readonly collections: Collections;
	readonly secret: string;
}

const DEFAULT_PREFIX = 'bumail_queue_';

/**
 * As the PostgreSQL store's `tablePrefix`: nothing MongoDB reads in a
 * collection's name (`$`, `.`, a NUL, `system.`), and nothing a shell
 * would need to quote.
 */
const PREFIX = /^[a-z_][a-z0-9_]{0,39}$/;

export function namesOf(value: unknown): Names {
	const prefix = value ?? DEFAULT_PREFIX;
	if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
		throw invalid(
			`collectionPrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not ${JSON.stringify(prefix)}`,
		);
	}
	return {
		prefix,
		items: `${prefix}items`,
		messages: `${prefix}messages`,
		schema: `${prefix}schema`,
	};
}

const NEEDS =
	'A MongoDB queue store needs db: a Db of the mongodb driver, or an object of its shape';

/**
 * Every collection is read and written with these, whatever the client
 * was opened with: a write acknowledged once a majority of the replica
 * set has it in its journal, so a failover keeps it; a read of what a
 * majority has, from the primary, so nothing read is rolled back later;
 * and the plain values the store reads.
 */
export const COLLECTION_OPTIONS: MongoQueueCollectionOptions = {
	writeConcern: { w: 'majority', j: true },
	readConcern: { level: 'majority' },
	readPreference: 'primary',
	raw: false,
	useBigInt64: false,
	promoteLongs: true,
	promoteValues: true,
	ignoreUndefined: true,
};

const isDb = (value: unknown): value is MongoQueueDb =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as MongoQueueDb).collection === 'function';

/**
 * The password of the client a driver's `Db` belongs to, if it shows
 * one: masked in any reason the store repeats, should the driver's name
 * it. Read by shape, as nothing in `MongoQueueDb`.
 */
function secretOf(db: MongoQueueDb): string {
	try {
		const password = (
			db as {
				client?: { options?: { credentials?: { password?: unknown } } };
			}
		).client?.options?.credentials?.password;
		return typeof password === 'string' ? password : '';
	} catch {
		return ''; // a getter that throws: nothing to mask
	}
}

export const reasonOf = (error: unknown, secret: string): string =>
	masked(error instanceof Error ? error.message : String(error), secret);

/** Checks the options and names the collections; connects to nothing. */
export function connect(options: MongoQueueStoreOptions): Connection {
	if (typeof options !== 'object' || options === null) throw invalid(NEEDS);
	if ((options as { url?: unknown }).url !== undefined) {
		// Never repeated: it may hold a password.
		throw invalid(
			'A MongoDB queue store takes db, not url: give it client.db() of a MongoClient of yours',
		);
	}
	const names = namesOf(options.collectionPrefix);
	const { db } = options;
	if (!isDb(db)) throw invalid(NEEDS);
	const secret = secretOf(db);
	try {
		return {
			names,
			secret,
			collections: {
				items: db.collection(names.items, COLLECTION_OPTIONS),
				messages: db.collection(names.messages, COLLECTION_OPTIONS),
				schema: db.collection(names.schema, COLLECTION_OPTIONS),
			},
		};
	} catch (error) {
		throw invalid(
			`db cannot give the queue's collections: ${reasonOf(error, secret)}`,
		);
	}
}
