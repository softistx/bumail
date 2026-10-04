import { mkdirSync, rmSync } from 'node:fs';
import { hostname as machineName } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../../errors';
import {
	HEARTBEAT_MS,
	heartbeat,
	type KeptFolder,
	makeFolder,
	sweep,
} from './folders';
import { type Spooled, writeSpooled } from './write';

export {
	HEARTBEAT_MS,
	type KeptFolder,
	OWNER_FILE,
	STALE_MS,
} from './folders';
export { spooledStream } from './stream';
export type { Spooled } from './write';

/** What `Spool.open` takes besides `data` and the budget: for specs. */
export interface SpoolOptions {
	readonly pid?: number;
	/** The time the sweep judges ages against. */
	readonly now?: number;
	readonly heartbeatMs?: number;
}

/**
 * Where messages wait while they are checked: `<data>/spool/<pid>-<random>`,
 * readable by the server alone, its owner file touched every
 * `HEARTBEAT_MS` so another server sharing `data` never sweeps it. It
 * holds `budget` bytes at most, counted as they are written.
 */
export class Spool {
	readonly dir: string;
	readonly budget: number;
	/** Folders under `<data>/spool` the sweep had to leave, unable to judge or remove them. */
	readonly kept: readonly KeptFolder[];
	#used = 0;
	readonly #stopBeat: () => void;

	private constructor(
		dir: string,
		budget: number,
		kept: readonly KeptFolder[],
		heartbeatMs: number,
	) {
		this.dir = dir;
		this.budget = budget;
		this.kept = kept;
		this.#stopBeat = heartbeat(dir, heartbeatMs);
	}

	/**
	 * Opens this process's spool under `data`, removing first the folders
	 * whose server stopped beating (`STALE_MS`). `UNAVAILABLE` when it
	 * cannot.
	 */
	static open(data: string, budget: number, options: SpoolOptions = {}): Spool {
		const root = join(data, 'spool');
		const host = machineName();
		const pid = options.pid ?? process.pid;
		const name = `${pid}-${crypto.randomUUID().slice(0, 8)}`;
		let dir: string;
		let kept: KeptFolder[];
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			kept = sweep(root, options.now ?? Date.now());
			dir = makeFolder(root, name, `${pid} ${host}\n`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new ServerError(
				'UNAVAILABLE',
				`the spool directory ${root} cannot be used (${reason})`,
			);
		}
		return new Spool(dir, budget, kept, options.heartbeatMs ?? HEARTBEAT_MS);
	}

	/** Stops the heartbeat and removes the spool folder, with anything left in it: at the end of a stop. */
	close(): void {
		this.#stopBeat();
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

	/** Spools `content` as `id`: see `writeSpooled`. */
	write(
		id: string,
		content: ReadableStream<Uint8Array>,
	): Promise<Spooled | 'full'> {
		return writeSpooled(this.dir, id, content, {
			hasRoom: (size) => this.hasRoom(size),
			add: (size) => {
				this.#used += size;
			},
		});
	}
}
