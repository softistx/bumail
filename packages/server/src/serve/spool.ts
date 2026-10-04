import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { hostname as machineName } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../errors';
import { HeaderEndScanner, MAX_HEADER_BYTES } from './header';

/** A message on its way in, on disk: removed once it is delivered or refused. */
export interface Spooled {
	readonly file: string;
	/** Its size, in bytes. */
	readonly size: number;
	/** The header's fields, each ending in CRLF; `undefined` when it is longer than `MAX_HEADER_BYTES`. */
	readonly header: Uint8Array | undefined;
	/** Where the blank line, then the body, starts; `size` when the message has no blank line. */
	readonly bodyStart: number;
	/** Removes the file, and gives its bytes back to the budget. */
	remove(): Promise<void>;
}

/** The file in each spool folder naming the server that owns it: `<pid> <hostname>`. */
export const OWNER_FILE = 'owner';

/** Whether a process of that id runs on this machine. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it runs, as another user.
		return (error as { code?: unknown }).code === 'EPERM';
	}
}

/** Milliseconds a folder with no owner file is given before it is swept: one being created. */
export const UNOWNED_GRACE_MS = 60_000;

/** A spool folder another machine owns: never swept, logged at start. */
export interface ForeignFolder {
	readonly path: string;
	readonly host: string;
}

/**
 * What to do with the spool folder at `path`, found at start: `sweep`
 * what no running server owns — no owner file (or a `.tmp` one, still
 * being created) older than `UNOWNED_GRACE_MS`, or an owner on this
 * machine whose process is gone or is this very one (a restart as pid 1
 * in a container); `keep` a live server's, or a fresh one being made;
 * `foreign` one another machine owns.
 */
function judgeFolder(
	path: string,
	name: string,
	self: { readonly pid: number; readonly host: string; readonly now: number },
): 'sweep' | 'keep' | { readonly host: string } {
	let owner: string | undefined;
	if (!name.endsWith('.tmp')) {
		try {
			owner = readFileSync(join(path, OWNER_FILE), 'utf8');
		} catch {
			owner = undefined;
		}
	}
	if (owner === undefined) {
		let age = Number.POSITIVE_INFINITY;
		try {
			age = self.now - statSync(path).mtimeMs;
		} catch {
			// Gone already, or unreadable: swept below, force ignoring a miss.
		}
		return age > UNOWNED_GRACE_MS ? 'sweep' : 'keep';
	}
	const [pid, from = ''] = owner.trim().split(' ');
	if (from !== self.host) return { host: from };
	const id = Number(pid);
	if (!Number.isInteger(id) || id === self.pid || !alive(id)) return 'sweep';
	return 'keep';
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
	const out = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/**
 * Where messages wait while they are checked: `<data>/spool/<pid>-<random>`,
 * readable by the server alone, with an owner file naming this process
 * and machine, so another server sharing `data` never sweeps it. It holds
 * `budget` bytes at most, counted as they are written.
 */
export class Spool {
	readonly dir: string;
	readonly budget: number;
	/** Folders another machine left under `<data>/spool`, kept. */
	readonly foreign: readonly ForeignFolder[];
	#used = 0;

	private constructor(
		dir: string,
		budget: number,
		foreign: readonly ForeignFolder[],
	) {
		this.dir = dir;
		this.budget = budget;
		this.foreign = foreign;
	}

	/**
	 * Opens this process's spool under `data`, removing first what a
	 * server no longer running left there. `UNAVAILABLE` when it cannot.
	 */
	static open(
		data: string,
		budget: number,
		self: { readonly pid?: number; readonly now?: number } = {},
	): Spool {
		const root = join(data, 'spool');
		const host = machineName();
		const pid = self.pid ?? process.pid;
		const now = self.now ?? Date.now();
		const name = `${pid}-${crypto.randomUUID().slice(0, 8)}`;
		const dir = join(root, name);
		const foreign: ForeignFolder[] = [];
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			for (const entry of readdirSync(root)) {
				const path = join(root, entry);
				const verdict = judgeFolder(path, entry, { pid, host, now });
				if (verdict === 'sweep') rmSync(path, { recursive: true, force: true });
				else if (verdict !== 'keep') foreign.push({ path, host: verdict.host });
			}
			// Made whole under another name, then renamed: a folder is never
			// seen without its owner.
			const making = join(root, `${name}.tmp`);
			mkdirSync(making, { mode: 0o700 });
			writeFileSync(join(making, OWNER_FILE), `${pid} ${host}\n`, {
				mode: 0o600,
			});
			renameSync(making, dir);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new ServerError(
				'UNAVAILABLE',
				`the spool directory ${root} cannot be used (${reason})`,
			);
		}
		return new Spool(dir, budget, foreign);
	}

	/** Removes the spool folder, with anything left in it: at the end of a stop. */
	close(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}

	/** Bytes the messages waiting hold. */
	get used(): number {
		return this.#used;
	}

	/** Whether a message of `size` more bytes fits within the budget. */
	hasRoom(size: number): boolean {
		return this.#used + size <= this.budget;
	}

	/**
	 * Reads `content` to its end into a new file named after `id`, keeping
	 * the header aside as it goes by, each byte scanned once. Answers
	 * `'full'` when the budget ran out on the way: the rest is read and
	 * dropped, the file removed. What the stream throws — the SMTP
	 * server's refusal of the message — is thrown, the file removed.
	 */
	async write(
		id: string,
		content: ReadableStream<Uint8Array>,
	): Promise<Spooled | 'full'> {
		const file = join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.eml`);
		const handle = await open(file, 'wx', 0o600);
		let held = 0;
		const release = () => {
			this.#used -= held;
			held = 0;
		};
		const remove = async () => {
			release();
			await rm(file, { force: true });
		};
		const scanner = new HeaderEndScanner();
		const head: Uint8Array[] = [];
		let full = false;
		try {
			const reader = content.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (full) continue;
				if (!this.hasRoom(value.length)) {
					full = true;
					continue;
				}
				this.#used += value.length;
				held += value.length;
				await handle.write(value);
				if (scanner.end === -1 && scanner.length <= MAX_HEADER_BYTES) {
					head.push(value);
				}
				scanner.add(value);
			}
		} catch (error) {
			await handle.close().catch(() => {});
			await remove();
			throw error;
		}
		try {
			await handle.close();
		} catch (error) {
			await remove();
			throw error;
		}
		if (full) {
			await remove();
			return 'full';
		}
		const size = scanner.length;
		// No blank line: the whole message is header.
		const bodyStart = scanner.end === -1 ? size : scanner.end;
		if (bodyStart > MAX_HEADER_BYTES) {
			return { file, size, header: undefined, bodyStart: 0, remove };
		}
		const kept = head.reduce((sum, chunk) => sum + chunk.length, 0);
		const header = concat(head, kept).subarray(0, bodyStart);
		return { file, size, header, bodyStart, remove };
	}
}

/** `prefix`, then the spooled file from `start`, as one stream. */
export function spooledStream(
	prefix: Uint8Array,
	file: string,
	start: number,
): ReadableStream<Uint8Array> {
	let rest: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let sentPrefix = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sentPrefix) {
				sentPrefix = true;
				if (prefix.length > 0) {
					controller.enqueue(prefix);
					return;
				}
			}
			rest ??= Bun.file(file).slice(start).stream().getReader();
			const { done, value } = await rest.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel(reason) {
			await rest?.cancel(reason);
		},
	});
}
