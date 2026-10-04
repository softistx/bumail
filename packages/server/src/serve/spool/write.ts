import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HeaderEndScanner, MAX_HEADER_BYTES } from '../header';
import { isMissing } from './folders';

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

/** The spool's byte count, as `writeSpooled` takes and gives back from it. */
export interface Budget {
	/** Whether `size` more bytes fit. */
	hasRoom(size: number): boolean;
	/** Counts `size` bytes more (or fewer, negative). */
	add(size: number): void;
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
 * Reads `content` to its end into a new file in `dir` named after `id`,
 * keeping the header aside as it goes by, each byte scanned once, every
 * byte counted in `budget`. Answers `'full'` when the budget ran out on
 * the way: the rest is read and dropped, the file removed. What the
 * stream throws — the SMTP server's refusal of the message — is thrown,
 * the file removed. When `dir` is missing — swept by another server —
 * `remake` makes it again and the file is opened once more, before any
 * of `content` is read.
 */
export async function writeSpooled(
	dir: string,
	id: string,
	content: ReadableStream<Uint8Array>,
	budget: Budget,
	remake?: () => void,
): Promise<Spooled | 'full'> {
	const file = join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.eml`);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(file, 'wx', 0o600);
	} catch (error) {
		if (remake === undefined || !isMissing(error)) throw error;
		remake();
		handle = await open(file, 'wx', 0o600);
	}
	let held = 0;
	const release = () => {
		budget.add(-held);
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
			if (!budget.hasRoom(value.length)) {
				full = true;
				continue;
			}
			budget.add(value.length);
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
