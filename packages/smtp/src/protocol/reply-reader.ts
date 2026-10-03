import type { Reply } from './reply';

/** The most lines one reply may have; an EHLO reply has a dozen or so. */
export const MAX_REPLY_LINES = 100;

/** A reply line's parts: `250-text` or `250 text`, or a bare `250`. */
interface ReplyLine {
	readonly code: number;
	readonly last: boolean;
	readonly text: string;
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/** RFC 5321 §4.2: three digits, the first 2 to 5, then a space, a hyphen, or nothing. */
function parseLine(line: string): ReplyLine | undefined {
	if (line.length < 3) return undefined;
	const a = line.charCodeAt(0);
	if (a < 0x32 || a > 0x35) return undefined;
	if (!isDigit(line.charCodeAt(1)) || !isDigit(line.charCodeAt(2)))
		return undefined;
	const code = Number(line.slice(0, 3));
	if (line.length === 3) return { code, last: true, text: '' };
	const separator = line[3];
	if (separator !== ' ' && separator !== '-') return undefined;
	return { code, last: separator === ' ', text: line.slice(4) };
}

/** `x.y.z` of RFC 3463, its class the reply's own first digit. */
function statusOf(code: number, text: string): string | undefined {
	const space = text.indexOf(' ');
	const token = space < 0 ? text : text.slice(0, space);
	if (token.length > 11 || !/^[245]\.\d{1,3}\.\d{1,3}$/.test(token))
		return undefined;
	return token[0] === String(code)[0] ? token : undefined;
}

/** A reply put together: the enhanced status taken off every line that starts with it. */
function build(code: number, lines: readonly string[]): Reply {
	const status = statusOf(code, lines[0] ?? '');
	const text = status
		? lines.map((line) =>
				line.startsWith(`${status} `)
					? line.slice(status.length + 1)
					: line === status
						? ''
						: line,
			)
		: [...lines];
	const body = text.length === 1 ? (text[0] as string) : text;
	return status === undefined
		? { code, text: body }
		: { code, status, text: body };
}

/**
 * Puts a server's reply lines together (RFC 5321 §4.2.1): `code-` lines,
 * then a `code ` line, all with the same code. Each line costs one pass,
 * and a reply holds `MAX_REPLY_LINES` at most; what is not a reply is an
 * error, never guessed at.
 */
export class ReplyReader {
	#lines: string[] = [];
	#code = 0;

	/** One line, CRLF taken off: the reply it completes, `undefined` while it goes on, or why it is not one. */
	line(text: string): Reply | { readonly error: string } | undefined {
		const parsed = parseLine(text);
		if (!parsed) {
			const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
			return {
				error: `a line that is not an SMTP reply: ${JSON.stringify(shown)}`,
			};
		}
		if (this.#lines.length > 0 && parsed.code !== this.#code) {
			return {
				error: `a reply whose lines change code, from ${this.#code} to ${parsed.code}`,
			};
		}
		if (this.#lines.length >= MAX_REPLY_LINES) {
			return { error: `a reply of more than ${MAX_REPLY_LINES} lines` };
		}
		this.#code = parsed.code;
		this.#lines.push(parsed.text);
		if (!parsed.last) return undefined;
		const lines = this.#lines;
		this.#lines = [];
		return build(parsed.code, lines);
	}
}

/** A reply's text as one line: its lines joined with a space. */
export function replyText(reply: Reply): string {
	return typeof reply.text === 'string' ? reply.text : reply.text.join(' ');
}
