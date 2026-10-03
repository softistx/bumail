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
 * Every control character (CR and LF included) as a space, runs of space
 * as one, cut at `max` characters with `...`: what a reply leaves in an
 * item, an event and a DSN.
 */
export function cleanText(text: string, max: number): string {
	const clean = replaceControls(text, ' ').replace(/ {2,}/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/** `cleanText`, then anything not printable ASCII as `?`: for a `message/delivery-status` field. */
export const asciiText = (text: string, max: number): string =>
	cleanText(text, max).replace(/[^ -~]/g, '?');
