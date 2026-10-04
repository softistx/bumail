import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as machineName } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../../errors';
import type { Log } from '../log';
import {
	HEARTBEAT_MS,
	heartbeat,
	type KeptFolder,
	makeFolder,
	OWNER_FILE,
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
	/** Where the spool tells it made its folder again. Default: nowhere. */
	readonly log?: Log;
}

/** Where a spool folder lives, and what its owner file reads. */
interface Place {
	readonly root: string;
	readonly name: string;
	readonly owner: string;
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
	#closed = false;
	readonly #place: Place;
	readonly #log: Log;
	readonly #stopBeat: () => void;

	private constructor(
		place: Place,
		budget: number,
		kept: readonly KeptFolder[],
		options: SpoolOptions,
	) {
		this.#place = place;
		this.dir = join(place.root, place.name);
		this.budget = budget;
		this.kept = kept;
		this.#log = options.log ?? (() => {});
		this.#stopBeat = heartbeat(
			this.dir,
			options.heartbeatMs ?? HEARTBEAT_MS,
			() => this.#remake(),
		);
	}

	/**
	 * Makes the folder again after another server swept it — this one
	 * stalled past `STALE_MS`, or the clocks disagree — so the messages
	 * after it still have somewhere to wait; tells the log. A folder
	 * still there only gets its owner file back. Once closed, it throws
	 * instead: a write after `close` never brings the folder back.
	 */
	#remake(): void {
		if (this.#closed) {
			throw new Error(`the spool folder ${this.dir} is closed`);
		}
		const { root, name, owner } = this.#place;
		if (existsSync(this.dir)) {
			writeFileSync(join(this.dir, OWNER_FILE), owner, { mode: 0o600 });
			return;
		}
		mkdirSync(root, { recursive: true, mode: 0o700 });
		makeFolder(root, name, owner);
		this.#log(
			`bumail: the spool folder ${this.dir} was removed while in use; made it again`,
		);
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
		const owner = `${pid} ${host}\n`;
		let kept: KeptFolder[];
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			kept = sweep(root, options.now ?? Date.now());
			makeFolder(root, name, owner);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new ServerError(
				'UNAVAILABLE',
				`the spool directory ${root} cannot be used (${reason})`,
			);
		}
		return new Spool({ root, name, owner }, budget, kept, options);
	}

	/** Stops the heartbeat and removes the spool folder, with anything left in it: at the end of a stop. */
	close(): void {
		this.#closed = true;
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

	/** Spools `content` as `id`, making the folder again once if it was swept: see `writeSpooled`. */
	write(
		id: string,
		content: ReadableStream<Uint8Array>,
	): Promise<Spooled | 'full'> {
		return writeSpooled(
			this.dir,
			id,
			content,
			{
				hasRoom: (size) => this.hasRoom(size),
				add: (size) => {
					this.#used += size;
				},
			},
			() => this.#remake(),
		);
	}
}
