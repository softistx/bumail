import { Checker } from '../config/checker';
import { MAX_FILE_SIZE, readText } from '../config/files';
import { ServerError } from '../errors';
import type { PasswordSource } from './args';

/** What reading a password needs of the process. */
export interface Terminal {
	/** All of standard input, as text. */
	readonly stdin: () => Promise<string>;
	/** Standard input is a terminal: a prompt can be answered. */
	readonly isTTY: boolean;
	/** Asks `label` on the terminal and reads a line without echoing it. */
	readonly prompt: (label: string) => Promise<string>;
}

/** The text without the one line break that ends it, as `echo` and editors leave. */
function chomp(text: string): string {
	return text.replace(/\r?\n$/, '');
}

/**
 * The new password, from where `source` says: typed twice at a prompt,
 * the whole of standard input, or a file (at most 1 MiB, read as the
 * configuration's files are); one final line break dropped. No message
 * repeats it.
 */
export async function readPassword(
	source: PasswordSource,
	terminal: Terminal,
	whose: string,
): Promise<string> {
	if (source.from === 'stdin') return chomp(await terminal.stdin());
	if (source.from === 'file') {
		const checker = new Checker();
		const text = readText(checker, source.file, '--password-file');
		if (text === undefined) {
			const [problem] = checker.problems;
			throw new ServerError(
				'INVALID',
				`${problem?.path ?? '--password-file'}: ${problem?.problem ?? 'cannot be read'}`,
			);
		}
		return chomp(text);
	}
	if (!terminal.isTTY) {
		throw new ServerError(
			'USAGE',
			'standard input is not a terminal, so no password can be typed: give --password-stdin or --password-file; see bumail --help',
		);
	}
	const first = await terminal.prompt(`New password for ${whose}: `);
	const again = await terminal.prompt('Again: ');
	if (first !== again) {
		throw new ServerError('INVALID', 'the two passwords typed differ');
	}
	return first;
}

/** The terminal's bytes decoded across chunks, and what came after the last Enter: a pasted second line. */
const decoder = new TextDecoder();
let typedAhead = '';

/**
 * Reads a line from the process's terminal without echoing it: raw mode,
 * Backspace erasing, Enter ending it, Ctrl-C and Ctrl-D giving up. A
 * character split across two reads is decoded whole, and what follows
 * an Enter is kept for the next prompt, so `pw⏎pw⏎` pasted at once
 * answers both.
 */
export function promptHidden(label: string): Promise<string> {
	const { stdin, stderr } = process;
	stderr.write(label);
	return new Promise((resolve, reject) => {
		let text = '';
		const finish = (rest: string, error?: ServerError) => {
			typedAhead = rest;
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			stderr.write('\n');
			if (error === undefined) resolve(text);
			else reject(error);
		};
		/** Takes `input`; `true` once the line is over. */
		const take = (input: string): boolean => {
			const chars = [...input];
			for (let i = 0; i < chars.length; i++) {
				const char = chars[i] ?? '';
				const rest = chars
					.slice(i + 1)
					.join('')
					.replace(/^\n/, '');
				if (char === '\r' || char === '\n') {
					finish(rest);
					return true;
				}
				if (char === '\u0003' || char === '\u0004') {
					finish('', new ServerError('INVALID', 'no password typed'));
					return true;
				}
				if (char === '\u007f' || char === '\b') {
					text = [...text].slice(0, -1).join('');
				} else {
					text += char;
				}
			}
			return false;
		};
		const onData = (chunk: Uint8Array) => {
			take(decoder.decode(chunk, { stream: true }));
		};
		const ahead = typedAhead;
		typedAhead = '';
		stdin.setRawMode(true);
		if (take(ahead)) return;
		stdin.resume();
		stdin.on('data', onData);
	});
}

/** All of standard input, as UTF-8, refused past 1 MiB as a password file is. */
export async function readStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of Bun.stdin.stream()) {
		size += chunk.length;
		if (size > MAX_FILE_SIZE) {
			throw new ServerError(
				'INVALID',
				'--password-stdin: is larger than 1 MiB',
			);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}
