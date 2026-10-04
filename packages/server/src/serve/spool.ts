import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerError } from '../errors';
import { HeaderEndScanner, MAX_HEADER_BYTES } from './header';

/**
 * A message on its way in, on disk rather than in memory: one file per
 * message under `<data>/spool/<pid>`, readable by the server alone,
 * removed once it is delivered or refused.
 */
export interface Spooled {
	readonly file: string;
	/** Its size, in bytes. */
	readonly size: number;
	/** The header's fields, each ending in CRLF; `undefined` when it is longer than `MAX_HEADER_BYTES`. */
	readonly header: Uint8Array | undefined;
	/** Where the blank line, then the body, starts; `size` when the message has no blank line. */
	readonly bodyStart: number;
	/** Removes the file. */
	remove(): Promise<void>;
}

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

/**
 * This process's spool directory, `<data>/spool/<pid>`, created private
 * and empty. What a server no longer running left there is removed; a
 * server still running on the same `data` keeps its own.
 */
export function openSpool(data: string, pid = process.pid): string {
	const root = join(data, 'spool');
	const dir = join(root, String(pid));
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(root)) {
			const owner = Number(name);
			const stale =
				name === String(pid) || !Number.isInteger(owner) || !alive(owner);
			if (stale) rmSync(join(root, name), { recursive: true, force: true });
		}
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ServerError(
			'UNAVAILABLE',
			`the spool directory ${root} cannot be used (${reason})`,
		);
	}
	return dir;
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
 * Reads `content` to its end into a new file of `dir` named after `id`,
 * keeping the header aside as it goes by, each byte scanned once. What
 * the stream throws — the SMTP server's refusal of the message — is
 * thrown, the file removed.
 */
export async function spool(
	dir: string,
	id: string,
	content: ReadableStream<Uint8Array>,
): Promise<Spooled> {
	const file = join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.eml`);
	const handle = await open(file, 'wx', 0o600);
	const remove = () => rm(file, { force: true });
	const scanner = new HeaderEndScanner();
	const head: Uint8Array[] = [];
	try {
		const reader = content.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await handle.write(value);
			const looking = scanner.end === -1;
			if (looking && scanner.length <= MAX_HEADER_BYTES) head.push(value);
			scanner.add(value);
		}
	} catch (error) {
		await handle.close();
		await remove();
		throw error;
	}
	await handle.close();
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
