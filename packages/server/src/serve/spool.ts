import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerError } from '../errors';
import { headerEnd, MAX_HEADER_BYTES } from './header';

/**
 * A message on its way in, on disk rather than in memory: `<data>/spool`,
 * one file per message, readable by the server alone, removed once it is
 * delivered or refused.
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

/** The spool directory under `data`, created private, emptied of what a stopped server left. */
export function openSpool(data: string): string {
	const dir = join(data, 'spool');
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(dir)) {
			if (name.endsWith('.eml')) rmSync(join(dir, name), { force: true });
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ServerError(
			'UNAVAILABLE',
			`the spool directory ${dir} cannot be used (${reason})`,
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
 * keeping the header aside as it goes by. What the stream throws — the
 * SMTP server's refusal of the message — is thrown, the file removed.
 */
export async function spool(
	dir: string,
	id: string,
	content: ReadableStream<Uint8Array>,
): Promise<Spooled> {
	const file = join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.eml`);
	const handle = await open(file, 'wx', 0o600);
	const remove = () => rm(file, { force: true });
	const head: Uint8Array[] = [];
	let headLength = 0;
	let end = -1;
	let overlong = false;
	let size = 0;
	try {
		const reader = content.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await handle.write(value);
			if (end === -1 && !overlong) {
				head.push(value);
				const before = headLength;
				headLength += value.length;
				const bytes = concat(head, headLength);
				head.splice(0, head.length, bytes);
				const found = headerEnd(bytes, Math.max(0, before - 3));
				if (found !== -1) end = found;
				else if (headLength > MAX_HEADER_BYTES) overlong = true;
			}
			size += value.length;
		}
	} catch (error) {
		await handle.close();
		await remove();
		throw error;
	}
	await handle.close();
	const all = head[0] ?? new Uint8Array(0);
	// No blank line: the whole message is header.
	const bodyStart = overlong ? 0 : end === -1 ? size : end;
	const header = overlong ? undefined : all.subarray(0, bodyStart);
	if (header !== undefined && header.length > MAX_HEADER_BYTES) {
		return { file, size, header: undefined, bodyStart: 0, remove };
	}
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
