import { isIP } from 'node:net';

/**
 * IP addresses as bytes, for the PROXY protocol: what `trusted` lists and
 * what a header names. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`)
 * is its IPv4 address, in both: a dual-stack listener reports an IPv4
 * peer that way.
 */

/** The 4 or 16 bytes of an IP address, or `undefined` for anything else, a zone included. */
export function addressBytes(text: string): Uint8Array | undefined {
	// A zone (`fe80::1%eth0`) names an interface of this host, never a client's.
	if (text.includes('%')) return undefined;
	const kind = isIP(text);
	if (kind === 4) return new Uint8Array(text.split('.').map(Number));
	if (kind !== 6) return undefined;
	return unmapped(ipv6Bytes(text.toLowerCase()));
}

/** The 16 bytes of a valid IPv6 address, a dotted tail included. */
function ipv6Bytes(text: string): Uint8Array {
	const bytes = new Uint8Array(16);
	let tail = text;
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (dotted) {
		bytes.set(dotted.slice(1).map(Number), 12);
		tail = `${text.slice(0, dotted.index)}0:0`;
	}
	const [head = '', rest] = tail.split('::');
	const left = head === '' ? [] : head.split(':');
	const right = rest === undefined || rest === '' ? [] : rest.split(':');
	const groups =
		rest === undefined
			? left
			: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	const view = new DataView(bytes.buffer);
	groups.forEach((group, at) => {
		if (!dotted || at < 6) view.setUint16(at * 2, Number.parseInt(group, 16));
	});
	return bytes;
}

/** An IPv4-mapped address as its 4 bytes; any other as it is. */
export function unmapped(bytes: Uint8Array): Uint8Array {
	if (bytes.length !== 16) return bytes;
	const mapped =
		bytes.subarray(0, 10).every((byte) => byte === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff;
	return mapped ? bytes.slice(12) : bytes;
}

/**
 * An address's text: dotted for IPv4 (an IPv4-mapped address included),
 * RFC 5952's form for IPv6 — lower case, no leading zeros, the longest
 * run of two zero groups or more as `::`.
 */
export function formatAddress(raw: Uint8Array): string {
	const bytes = unmapped(raw);
	if (bytes.length === 4) return bytes.join('.');
	const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
	const groups = Array.from({ length: 8 }, (_, at) => view.getUint16(at * 2));
	let best = { at: -1, length: 1 };
	for (let at = 0; at < 8; ) {
		let end = at;
		while (end < 8 && groups[end] === 0) end++;
		if (end - at > best.length) best = { at, length: end - at };
		at = end === at ? at + 1 : end;
	}
	const hex = groups.map((group) => group.toString(16));
	if (best.at < 0) return hex.join(':');
	const left = hex.slice(0, best.at).join(':');
	const right = hex.slice(best.at + best.length).join(':');
	return `${left}::${right}`;
}
