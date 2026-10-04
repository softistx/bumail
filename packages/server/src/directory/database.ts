import { Database } from 'bun:sqlite';
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ServerError } from '../errors';
import { migrate } from './schema';

/** The directory's file and its WAL: password hashes, its owner's alone. */
const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;

/** How long a write waits for another process's, in milliseconds, before it fails. */
const BUSY_TIMEOUT_MS = 5000;

/** The file a `sqlite:` URL names: `sqlite:/data/directory.sqlite` is `/data/directory.sqlite`. */
export function directoryFile(url: string): string {
	if (!url.startsWith('sqlite:')) {
		throw new ServerError(
			'INVALID',
			'the directory URL must be sqlite: and a path',
		);
	}
	return decodeURIComponent(new URL(url).pathname);
}

function keepPrivate(file: string): void {
	for (const path of [file, `${file}-wal`, `${file}-shm`]) {
		if (existsSync(path)) chmodSync(path, PRIVATE_FILE);
	}
}

/**
 * Creates `file` empty and 0600 when it is missing, so it is never
 * readable by others, even between SQLite creating it and a `chmod`.
 */
function createPrivate(file: string): void {
	try {
		closeSync(
			openSync(
				file,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
				PRIVATE_FILE,
			),
		);
	} catch (error) {
		if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
	}
}

function reason(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string') return code;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the directory's database, creating it and its directory if need
 * be, in WAL mode — so the server reads while the `bumail` command
 * writes, each from its own process — and at the last migration. What
 * fails is `ServerError('UNAVAILABLE')`, naming the file.
 */
export function openDatabase(file: string): Database {
	let db: Database | undefined;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY });
		createPrivate(file);
		db = new Database(file, { create: true, readwrite: true, strict: true });
		keepPrivate(file);
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA synchronous = FULL');
		db.exec('PRAGMA fullfsync = ON');
		db.exec('PRAGMA foreign_keys = ON');
		migrate(db);
		keepPrivate(file);
		return db;
	} catch (error) {
		db?.close();
		if (error instanceof ServerError) throw error;
		throw new ServerError(
			'UNAVAILABLE',
			`the directory ${file} cannot be opened (${reason(error)})`,
		);
	}
}

/**
 * Runs `fn` in a `BEGIN IMMEDIATE` transaction, so its checks and its
 * writes see no other writer between them. A lock another process holds
 * past the busy timeout, or any other failure of SQLite's, is
 * `ServerError('UNAVAILABLE')`; a `ServerError` of `fn` passes as it is.
 */
export function immediate<T>(db: Database, fn: () => T): T {
	try {
		return db.transaction(fn).immediate();
	} catch (error) {
		if (error instanceof ServerError) throw error;
		const code = reason(error);
		if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
			throw new ServerError(
				'UNAVAILABLE',
				`the directory is in use by another process (${code})`,
			);
		}
		throw new ServerError('UNAVAILABLE', `the directory failed (${code})`);
	}
}
