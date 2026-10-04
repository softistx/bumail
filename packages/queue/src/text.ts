/** Text from the other side, made safe to keep and to write in a header field. */

/** C0, DEL and C1: every control character, CR, LF and TAB included. */
const isControl = (code: number) =>
	code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Whether the text holds a control character. */
export function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (isControl(text.charCodeAt(i))) return true;
	}
	return false;
}

/** Each control character replaced by `by`. */
export function replaceControls(text: string, by: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		out += isControl(text.charCodeAt(i)) ? by : (text[i] as string);
	}
	return out;
}

/**
 * Every control character (CR and LF included) as a space, a lone
 * surrogate as U+FFFD, runs of space as one, cut at `max` characters with
 * `...`, never inside a surrogate pair: what a reply leaves in an item,
 * an event and a DSN.
 */
export function cleanText(text: string, max: number): string {
	const clean = replaceControls(text.toWellFormed(), ' ')
		.replace(/ {2,}/g, ' ')
		.trim();
	return clean.length > max ? `${cut(clean, max - 3)}...` : clean;
}

/**
 * The first `length` UTF-16 units, never ending inside a surrogate pair:
 * a lone surrogate is text no store can keep (PostgreSQL's `jsonb` refuses
 * it), nor any UTF-8 encode.
 */
function cut(text: string, length: number): string {
	const head = text.slice(0, length);
	const last = head.charCodeAt(head.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * Text every store can keep: no NUL (PostgreSQL's `text` and `jsonb` hold
 * none) and no lone surrogate. `cleanText`'s output always is.
 */
export const isStorable = (text: string): boolean =>
	text.isWellFormed() && !text.includes('\0');

/** `cleanText`, then anything not printable ASCII as `?`: for a `message/delivery-status` field. */
export const asciiText = (text: string, max: number): string =>
	cleanText(text, max).replace(/[^ -~]/g, '?');
