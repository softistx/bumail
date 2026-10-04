import type { MessageHeaders } from '@bumail/mime';
import type { Message } from '@bumail/store';
import type { CallContext } from '../api/context';
import { MethodError } from '../api/errors';
import { parsed } from './headers';
import { parseEmail, walk } from './parse';
import { textOf } from './structure';
import { htmlText } from './values';

/** Bytes of each text part a search reads. */
const SEARCH_BYTES = 1024 * 1024;

/** How many emails one query may read the content of. */
export interface ReadBudget {
	left: number;
}

/**
 * An email as a query sees it: its record at once, its header and its
 * text read from the store only when a condition or a sort asks, once.
 */
export class Candidate {
	readonly message: Message;
	readonly #ctx: CallContext;
	readonly #budget: ReadBudget;
	#headers: Promise<MessageHeaders> | undefined;
	#text: Promise<string> | undefined;

	constructor(message: Message, ctx: CallContext, budget: ReadBudget) {
		this.message = message;
		this.#ctx = ctx;
		this.#budget = budget;
	}

	async #blob(): Promise<Blob> {
		if (--this.#budget.left < 0) {
			throw new MethodError(
				'requestTooLarge',
				`The query reads more than ${this.#ctx.settings.limits.maxQueryScan} emails`,
			);
		}
		const blob = await this.#ctx.store.readContent(
			this.#ctx.accountId,
			this.message.blobId,
		);
		return blob ?? new Blob([]);
	}

	headers(): Promise<MessageHeaders> {
		this.#headers ??= this.#blob().then(
			async (blob) => (await parseEmail(blob, { headerOnly: true })).headers,
		);
		return this.#headers;
	}

	/** One header field's text, decoded; `''` when absent. */
	async header(name: string): Promise<string> {
		const value = (await this.headers()).getAll(name).at(-1);
		return value === undefined ? '' : (parsed(value, 'asText') as string);
	}

	/** The text of every text part, the first MiB of each, HTML tags dropped. */
	text(): Promise<string> {
		this.#text ??= this.#blob().then(async (blob) => {
			const root = await parseEmail(blob, { keepText: SEARCH_BYTES });
			const texts: string[] = [];
			for (const part of walk(root)) {
				if (part.contentType.type !== 'text') continue;
				const { text } = textOf(part);
				texts.push(
					part.contentType.subtype.toLowerCase() === 'html'
						? htmlText(text)
						: text,
				);
			}
			return texts.join('\n');
		});
		return this.#text;
	}
}

/** Whether `text` contains `needle`, case folded. */
export const contains = (text: string, needle: string) =>
	text.toLowerCase().includes(needle.toLowerCase());
