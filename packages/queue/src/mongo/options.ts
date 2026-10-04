/**
 * Where a MongoDB queue keeps its items, and the database it reaches them
 * through.
 *
 * Typed by shape, with only the driver's methods the store calls: the
 * package depends on no driver, not even as a peer, and the declarations
 * a consumer's `tsc` reads from `@bumail/queue/mongo` name nothing of
 * one. A `Db` of the official `mongodb` driver, 6 or later, fits
 * `MongoQueueDb` (`open.spec.ts` checks it), and so does any object with
 * these methods.
 */

/** A document as the store writes and reads it. */
export type MongoQueueDocument = { readonly [field: string]: unknown };

/** What a `find` hands back: the store only ever reads it whole, a page at most. */
export interface MongoQueueCursor {
	toArray(): Promise<MongoQueueDocument[]>;
}

/** The options the store gives a collection: see `MongoQueueDb.collection`. */
export interface MongoQueueCollectionOptions {
	readonly writeConcern: { readonly w: 'majority'; readonly j: true };
	readonly readConcern: { readonly level: 'majority' };
	readonly readPreference: 'primary';
	/** Plain values back, whatever the client was opened with. */
	readonly raw: false;
	readonly useBigInt64: false;
	readonly promoteLongs: true;
	readonly promoteValues: true;
	readonly ignoreUndefined: true;
}

/** The methods of a driver's `Collection` the store calls, each with the options it gives. */
export interface MongoQueueCollection {
	findOne(
		filter: MongoQueueDocument,
		options?: { readonly projection?: MongoQueueDocument },
	): Promise<MongoQueueDocument | null>;
	find(
		filter: MongoQueueDocument,
		options?: {
			readonly sort?: MongoQueueDocument;
			readonly skip?: number;
			readonly limit?: number;
			readonly projection?: MongoQueueDocument;
		},
	): MongoQueueCursor;
	insertOne(document: MongoQueueDocument): Promise<unknown>;
	insertMany(
		documents: readonly MongoQueueDocument[],
		options?: { readonly ordered?: boolean },
	): Promise<unknown>;
	/** Resolves with the document as it stands once updated, or `null` when the filter matched none. */
	findOneAndUpdate(
		filter: MongoQueueDocument,
		update: MongoQueueDocument,
		options: {
			readonly returnDocument: 'after';
			readonly sort?: MongoQueueDocument;
			readonly upsert?: boolean;
			readonly projection?: MongoQueueDocument;
		},
	): Promise<MongoQueueDocument | null>;
	/** Resolves with the document as it stood, or `null` when the filter matched none. */
	findOneAndDelete(
		filter: MongoQueueDocument,
	): Promise<MongoQueueDocument | null>;
	deleteMany(filter: MongoQueueDocument): Promise<unknown>;
	countDocuments(filter: MongoQueueDocument): Promise<number>;
	/** An ascending index on `keys`. */
	createIndex(
		keys: { readonly [field: string]: 1 },
		options: {
			readonly name: string;
			readonly unique?: boolean;
			readonly partialFilterExpression?: MongoQueueDocument;
		},
	): Promise<string>;
}

/** A database, such as `new MongoClient(url).db('mail')` of the `mongodb` driver. */
export interface MongoQueueDb {
	/** Makes no request: the driver connects at the first operation. */
	collection(
		name: string,
		options: MongoQueueCollectionOptions,
	): MongoQueueCollection;
}

export interface MongoQueueStoreOptions {
	/**
	 * The database, from a client the application opens, configures and
	 * closes itself: the store never closes it.
	 */
	readonly db: MongoQueueDb;
	/**
	 * Put before each collection's name, so several queues, or a queue and
	 * the application, share one database: lowercase letters, digits and
	 * underscores, at most 40. Default `bumail_queue_`.
	 */
	readonly collectionPrefix?: string;
}
