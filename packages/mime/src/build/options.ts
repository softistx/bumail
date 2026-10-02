import type { Mailbox } from '../headers/addresses';

export type AddressInput = Mailbox | string;

/** A file attached to a message. */
export interface Attachment {
	readonly content: Uint8Array | string;
	readonly filename?: string;
	/** Default `application/octet-stream`. */
	readonly contentType?: string;
	/**
	 * A `Content-ID`, without brackets: the HTML body shows the file with
	 * `<img src="cid:…">`, and it travels in a `multipart/related`.
	 */
	readonly contentId?: string;
}

export interface MessageOptions {
	readonly from: AddressInput;
	readonly to?: AddressInput | readonly AddressInput[];
	readonly cc?: AddressInput | readonly AddressInput[];
	/** Never written into the message: only `envelopeOf` reads it. */
	readonly bcc?: AddressInput | readonly AddressInput[];
	readonly replyTo?: AddressInput | readonly AddressInput[];
	readonly sender?: AddressInput;
	readonly subject?: string;
	/** Default: now. */
	readonly date?: Date;
	/** Without brackets. Default: a random one at the sender's domain. */
	readonly messageId?: string;
	readonly inReplyTo?: string;
	readonly references?: readonly string[];
	readonly text?: string;
	readonly html?: string;
	readonly attachments?: readonly Attachment[];
	/**
	 * More fields, written after the others. Values are encoded when they are
	 * not ASCII. A field the builder writes itself — the addresses, `Subject`,
	 * `Date`, the ids, `MIME-Version`, any `Content-*` — is refused here.
	 */
	readonly headers?: Readonly<Record<string, string>>;
}
