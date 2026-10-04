import { Checker } from '../config/checker';
import { MAX_FILE_SIZE, readText } from '../config/files';
import { ServerError } from '../errors';
import type { PasswordSource } from './verbs';

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

/** What a hidden prompt has read: the line so far, and what came after the last line. */
export interface LineState {
	/** The line typed so far. */
	text: string;
	/** Decoded input not yet taken: what followed an Enter, for the next line. */
	pending: string;
	/** The last character taken was a CR, so an LF right after it is part of that Enter. */
	afterReturn: boolean;
	/** Decodes the terminal's bytes, a character split across two reads included. */
	readonly decoder: TextDecoder;
}

/** What `take` found. */
export type Taken =
	| { readonly kind: 'more' }
	| { readonly kind: 'line'; readonly line: string }
	| { readonly kind: 'cancel' };

/** A fresh state, for a terminal read from the start. */
export function lineState(): LineState {
	return {
		text: '',
		pending: '',
		afterReturn: false,
		decoder: new TextDecoder(),
	};
}

/**
 * Takes what the terminal sent, after what was pending: Backspace (DEL
 * or BS) erases a character, Enter (CR, LF, or CR LF even split across
 * reads) ends the line, Ctrl-C or Ctrl-D cancels it. What follows an
 * Enter stays pending for the next line, so `pw⏎pw⏎` pasted at once
 * answers two prompts. Changes `state`; reads nothing else.
 */
export function take(
	state: LineState,
	chunk: Uint8Array = new Uint8Array(),
): Taken {
	const chars = [
		...(state.pending + state.decoder.decode(chunk, { stream: true })),
	];
	state.pending = '';
	for (let i = 0; i < chars.length; i++) {
		const char = chars[i] ?? '';
		const afterReturn = state.afterReturn;
		state.afterReturn = char === '\r';
		if (char === '\n' && afterReturn) continue;
		if (char === '\r' || char === '\n') {
			const line = state.text;
			state.text = '';
			state.pending = chars.slice(i + 1).join('');
			return { kind: 'line', line };
		}
		if (char === '\u0003' || char === '\u0004') {
			state.text = '';
			return { kind: 'cancel' };
		}
		if (char === '\u007f' || char === '\b') {
			state.text = [...state.text].slice(0, -1).join('');
		} else {
			state.text += char;
		}
	}
	return { kind: 'more' };
}

/** The process's terminal, across prompts. */
const terminal = lineState();

/**
 * Reads a line from the process's terminal without echoing it, in raw
 * mode, as `take` reads it.
 */
export function promptHidden(label: string): Promise<string> {
	const { stdin, stderr } = process;
	stderr.write(label);
	return new Promise((resolve, reject) => {
		const settle = (taken: Taken): boolean => {
			if (taken.kind === 'more') return false;
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			stderr.write('\n');
			if (taken.kind === 'line') resolve(taken.line);
			else reject(new ServerError('INVALID', 'no password typed'));
			return true;
		};
		const onData = (chunk: Uint8Array) => {
			settle(take(terminal, chunk));
		};
		stdin.setRawMode(true);
		if (settle(take(terminal))) return;
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
