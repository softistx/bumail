/** An SMTP reply (RFC 5321 §4.2), with its enhanced status code (RFC 3463) when it has one. */
export interface Reply {
	readonly code: number;
	/** `x.y.z`, written before the text of each line (RFC 2034 §4). */
	readonly status?: string;
	/** One line or more; a multi-line reply joins them with `code-`. */
	readonly text: string | readonly string[];
}

/** The reply as sent: every line but the last as `code-`, the last as `code `, each ending in CRLF. */
export function formatReply(reply: Reply, enhanced = true): string {
	const lines = typeof reply.text === 'string' ? [reply.text] : reply.text;
	const status = enhanced && reply.status ? `${reply.status} ` : '';
	return lines
		.map((line, i) => {
			const clean = line.replace(/[\r\n]+/g, ' ');
			return `${reply.code}${i === lines.length - 1 ? ' ' : '-'}${status}${clean}\r\n`;
		})
		.join('');
}

/** Builds a reply. */
export const reply = (
	code: number,
	status: string | undefined,
	text: string | readonly string[],
): Reply => (status === undefined ? { code, text } : { code, status, text });
