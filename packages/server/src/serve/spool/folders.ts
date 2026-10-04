import {
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * The file in each spool folder its server touches every `HEARTBEAT_MS`;
 * it reads `<pid> <hostname>`, for a person looking, and nothing judges
 * by it.
 */
export const OWNER_FILE = 'owner';

/** How often a running server touches its folder's owner file. */
export const HEARTBEAT_MS = 30_000;

/**
 * How long an owner file (or a folder without one) may go untouched
 * before its folder counts as left behind: ten heartbeats missed. Ages
 * are read against this machine's clock, so the machines sharing a
 * `data` over a network filesystem keep their clocks within a minute or
 * so of each other.
 */
export const STALE_MS = 5 * 60_000;

/** A folder under `<data>/spool` left in place because it could not be judged. */
export interface KeptFolder {
	readonly path: string;
	readonly reason: string;
}

function codeOf(error: unknown): unknown {
	return (error as { code?: unknown } | null)?.code;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * When the folder at `path` was last known alive: its owner file's
 * mtime, else — no owner file, a folder being made — its own. `gone`
 * when the folder went meanwhile; an error other than a missing file is
 * thrown.
 */
function lastSeen(path: string): number | 'gone' {
	try {
		return statSync(join(path, OWNER_FILE)).mtimeMs;
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') throw error;
	}
	try {
		return statSync(path).mtimeMs;
	} catch (error) {
		if (codeOf(error) === 'ENOENT') return 'gone';
		throw error;
	}
}

/**
 * Removes from `root` every folder whose heartbeat stopped more than
 * `STALE_MS` before `now`, whatever its pid or host: pids and hostnames
 * repeat across containers, a heartbeat does not. Answers the folders it
 * had to keep, unable to tell their age or to remove them.
 */
export function sweep(root: string, now: number): KeptFolder[] {
	const kept: KeptFolder[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		let seen: number | 'gone';
		try {
			seen = lastSeen(path);
		} catch (error) {
			kept.push({
				path,
				reason: `its age cannot be read (${reasonOf(error)})`,
			});
			continue;
		}
		if (seen === 'gone' || now - seen <= STALE_MS) continue;
		try {
			rmSync(path, { recursive: true, force: true });
		} catch (error) {
			kept.push({ path, reason: `it cannot be removed (${reasonOf(error)})` });
		}
	}
	return kept;
}

/**
 * Makes the folder `name` under `root` with its owner file, whole under
 * a `.tmp` name first and then renamed: a folder is never seen without
 * its owner.
 */
export function makeFolder(root: string, name: string, owner: string): string {
	const making = join(root, `${name}.tmp`);
	const dir = join(root, name);
	mkdirSync(making, { mode: 0o700 });
	writeFileSync(join(making, OWNER_FILE), owner, { mode: 0o600 });
	renameSync(making, dir);
	return dir;
}

/**
 * Touches `dir`'s owner file every `ms`, so no other server sweeps the
 * folder; the timer never keeps the process alive. A touch that fails is
 * tried again at the next beat. Answers the stop.
 */
export function heartbeat(dir: string, ms: number): () => void {
	const owner = join(dir, OWNER_FILE);
	const timer = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(owner, now, now);
		} catch {
			// Tried again at the next beat; STALE_MS is ten of them.
		}
	}, ms);
	timer.unref();
	return () => clearInterval(timer);
}
