import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StoreError } from '../errors';
import { BlobFiles } from './blobs';
import { makeDirectory, PRIVATE_FILE } from './disk';
import type { SqliteMailStoreOptions } from './options';
import { migrate } from './schema';

export interface Opened {
	readonly db: Database;
	readonly blobs: BlobFiles;
}

/** Applies the PRAGMAs, then takes the database's lock and keeps it until closed. */
function configure(db: Database): void {
	// Fail at once rather than wait for another opener to let go.
	db.exec('PRAGMA busy_timeout = 0');
	db.exec('PRAGMA locking_mode = EXCLUSIVE');
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = FULL');
	// On macOS a plain fsync leaves the data in the drive's cache: FULL is
	// durable there only with F_FULLFSYNC. Linux ignores the PRAGMA.
	db.exec('PRAGMA fullfsync = ON');
	db.exec('PRAGMA foreign_keys = ON');
	// In EXCLUSIVE mode the lock a write takes is never released: a second
	// opener, in this process or another, finds the database locked.
	db.exec('BEGIN EXCLUSIVE');
	db.exec('COMMIT');
}

/**
 * The database and a WAL a crash left are the owner's alone, whoever made
 * them: SQLite creates its files 0644, and a new WAL takes the database's
 * mode.
 */
function keepPrivate(file: string): void {
	for (const path of [file, `${file}-wal`]) {
		if (existsSync(path)) chmodSync(path, PRIVATE_FILE);
	}
}

/** Whether any account holds a blob, as the database says. */
function heldBy(db: Database): (blobId: string) => boolean {
	const query = db.query<unknown, [string]>(
		'SELECT 1 FROM account_blobs WHERE blob_id = ? LIMIT 1',
	);
	return (blobId) => query.get(blobId) !== null;
}

function why(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
		return 'it is already open, in this process or another: a database has one store at a time';
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the store's directory: its database, at the last migration and
 * locked for this store alone, and its blobs, rid of those no account
 * holds. Whatever fails is `INVALID`, naming the directory.
 */
export function openDirectory(options: SqliteMailStoreOptions): Opened {
	const directory = (options as SqliteMailStoreOptions | undefined)?.directory;
	if (typeof directory !== 'string' || directory === '') {
		throw new StoreError('INVALID', 'A SQLite store needs a directory');
	}
	let db: Database | undefined;
	try {
		makeDirectory(directory);
		const file = join(directory, 'mail.sqlite');
		db = new Database(file, { create: true, readwrite: true, strict: true });
		keepPrivate(file);
		configure(db);
		migrate(db);
		const blobs = new BlobFiles(join(directory, 'blobs'));
		blobs.sweep(heldBy(db));
		return { db, blobs };
	} catch (error) {
		db?.close();
		if (error instanceof StoreError) throw error;
		throw new StoreError(
			'INVALID',
			`The store at "${directory}" cannot be opened: ${why(error)}`,
		);
	}
}
