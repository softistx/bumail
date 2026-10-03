import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { QueueError } from '../errors';
import type { SqliteQueueStoreOptions } from './options';
import { migrate } from './schema';

/** The queue's directory and files: its owner's alone, as mail is. */
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

/**
 * Several processes may share the database: WAL lets readers go on while
 * one writes, and a writer waits up to `busy_timeout` for another. Every
 * write is flushed before it is acknowledged.
 */
function configure(db: Database, busyTimeout: number): void {
	db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = FULL');
	// On macOS a plain fsync leaves the data in the drive's cache.
	db.exec('PRAGMA fullfsync = ON');
	db.exec('PRAGMA foreign_keys = ON');
}

function keepPrivate(file: string): void {
	for (const path of [file, `${file}-wal`, `${file}-shm`]) {
		if (existsSync(path)) chmodSync(path, PRIVATE_FILE);
	}
}

function busyTimeoutOf(value: unknown): number {
	if (value === undefined) return 5000;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new QueueError(
			'INVALID',
			`busyTimeout must be an integer of at least 0, not ${value}`,
		);
	}
	return value;
}

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Opens the queue's database in `directory`, at the last migration.
 * Whatever fails is `INVALID`, naming the directory.
 */
export function openDatabase(options: SqliteQueueStoreOptions): Database {
	const directory = (options as SqliteQueueStoreOptions | undefined)?.directory;
	if (typeof directory !== 'string' || directory === '') {
		throw new QueueError('INVALID', 'A SQLite queue store needs a directory');
	}
	const busyTimeout = busyTimeoutOf(options.busyTimeout);
	let db: Database | undefined;
	try {
		mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
		const file = join(directory, 'queue.sqlite');
		db = new Database(file, { create: true, readwrite: true, strict: true });
		configure(db, busyTimeout);
		keepPrivate(file);
		migrate(db);
		return db;
	} catch (error) {
		db?.close();
		if (error instanceof QueueError) throw error;
		throw new QueueError(
			'INVALID',
			`The queue at "${directory}" cannot be opened: ${messageOf(error)}`,
		);
	}
}
