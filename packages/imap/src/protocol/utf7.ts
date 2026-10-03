/**
 * Modified UTF-7 (RFC 3501 §5.1.3), the mailbox name encoding of IMAP4rev1.
 * An IMAP4rev2 session (after ENABLE IMAP4rev2) uses UTF-8 instead.
 */

function isDirect(code: number): boolean {
	return code >= 0x20 && code <= 0x7e;
}

function encodeRun(run: string): string {
	const bytes = new Uint8Array(run.length * 2);
	for (let i = 0; i < run.length; i++) {
		const code = run.charCodeAt(i);
		bytes[i * 2] = code >> 8;
		bytes[i * 2 + 1] = code & 0xff;
	}
	return `&${bytes.toBase64({ omitPadding: true }).replaceAll('/', ',')}-`;
}

/** A name in UTF-8 to modified UTF-7. */
export function encodeUtf7(name: string): string {
	let out = '';
	let run = '';
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		if (isDirect(code)) {
			if (run !== '') out += encodeRun(run);
			run = '';
			out += code === 0x26 ? '&-' : name[i];
		} else {
			run += name[i];
		}
	}
	if (run !== '') out += encodeRun(run);
	return out;
}

function decodeRun(base64: string): string | undefined {
	if (!/^[A-Za-z0-9+,]+$/.test(base64)) return undefined;
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.fromBase64(base64.replaceAll(',', '/'));
	} catch {
		return undefined;
	}
	if (bytes.length % 2 !== 0) return undefined;
	let out = '';
	for (let i = 0; i < bytes.length; i += 2) {
		out += String.fromCharCode(
			((bytes[i] as number) << 8) | (bytes[i + 1] as number),
		);
	}
	// A run that only holds what could have been written directly is not canonical.
	for (let i = 0; i < out.length; i++) {
		if (isDirect(out.charCodeAt(i))) return undefined;
	}
	return out;
}

/** A modified UTF-7 name to UTF-8; `undefined` when it is not valid. */
export function decodeUtf7(name: string): string | undefined {
	let out = '';
	let at = 0;
	while (at < name.length) {
		const amp = name.indexOf('&', at);
		const plain = name.slice(at, amp < 0 ? name.length : amp);
		for (let i = 0; i < plain.length; i++) {
			if (!isDirect(plain.charCodeAt(i))) return undefined;
		}
		out += plain;
		if (amp < 0) break;
		const dash = name.indexOf('-', amp);
		if (dash < 0) return undefined;
		if (dash === amp + 1) {
			out += '&';
		} else {
			const run = decodeRun(name.slice(amp + 1, dash));
			if (run === undefined) return undefined;
			out += run;
		}
		at = dash + 1;
	}
	return out;
}
