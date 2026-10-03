import { LineSplitter, MAX_LINE } from '../protocol/lines';
import type { Reply } from '../protocol/reply';
import { ReplyReader } from '../protocol/reply-reader';

/** The most bytes a server may send in one session, every reply together. */
export const MAX_REPLY_BYTES = 1024 * 1024;

/**
 * What a server sent, put together into replies, each bounded: `MAX_LINE`
 * a line, `MAX_REPLY_LINES` a reply, `MAX_REPLY_BYTES` in all. One pass
 * over the bytes, whatever the chunks.
 */
export class Inbox {
	readonly #lines = new LineSplitter();
	readonly #reader = new ReplyReader();
	readonly #replies: Reply[] = [];
	#received = 0;

	/** Takes the next bytes; says what is wrong with them, if they are not replies. */
	push(chunk: Uint8Array): string | undefined {
		this.#received += chunk.length;
		if (this.#received > MAX_REPLY_BYTES) {
			return `more than ${MAX_REPLY_BYTES} bytes of replies`;
		}
		this.#lines.push(chunk);
		for (let event = this.#lines.next(); event; event = this.#lines.next()) {
			if ('tooLong' in event)
				return `a reply line longer than ${MAX_LINE} bytes`;
			const result = this.#reader.line(event.line);
			if (result === undefined) continue;
			if ('error' in result) return result.error;
			this.#replies.push(result);
		}
		return undefined;
	}

	/** The next complete reply. */
	shift(): Reply | undefined {
		return this.#replies.shift();
	}

	/** Bytes or replies not yet read. */
	get holding(): boolean {
		return this.#lines.holding || this.#replies.length > 0;
	}
}
