import { addressBytes } from './address';

/** What a proxy sends first: the headers of HAProxy's proxy-protocol.txt, for specs. */

/** A v1 line (§2.1) for a TCP client at `source`, to port 25 of a documentation address. */
export function v1(source: string): Uint8Array {
	const six = source.includes(':');
	const family = six ? 'TCP6' : 'TCP4';
	const destination = six ? '2001:db8::25' : '192.0.2.1';
	return new TextEncoder().encode(
		`PROXY ${family} ${source} ${destination} 56324 25\r\n`,
	);
}

export const SIGNATURE = [
	0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
];

/** A TLV (§2.2.7): type, 16-bit length, value. */
export function tlv(type: number, value: Uint8Array): Uint8Array {
	return new Uint8Array([
		type,
		value.length >> 8,
		value.length & 0xff,
		...value,
	]);
}

export interface V2 {
	/** 0 LOCAL, 1 PROXY. Default PROXY. */
	readonly command?: number;
	/** 0 UNSPEC, 1 INET, 2 INET6, 3 UNIX. Default from `source`. */
	readonly family?: number;
	/** 0 UNSPEC, 1 STREAM, 2 DGRAM. Default STREAM. */
	readonly transport?: number;
	readonly source?: string;
	readonly tlvs?: readonly Uint8Array[];
	/** Overrides the length field. */
	readonly length?: number;
}

/** A v2 header (§2.2): the client at `source`, to port 25 of a documentation address. */
export function v2(header: V2 = {}): Uint8Array {
	const { command = 1, transport = 1, source, tlvs = [] } = header;
	const raw = source === undefined ? undefined : addressOf(source);
	const family = header.family ?? (raw?.length === 4 ? 1 : raw ? 2 : 0);
	let block: number[] = [];
	if (family === 1 || family === 2) {
		const size = family === 1 ? 4 : 16;
		const from = raw ?? new Uint8Array(size);
		const to = new Uint8Array(size);
		to[0] = family === 1 ? 192 : 0x20;
		block = [...from, ...to, 0xdc, 0x04, 0x00, 25];
	} else if (family === 3) {
		block = Array(216).fill(0);
	}
	const body = [...block, ...tlvs.flatMap((one) => [...one])];
	const length = header.length ?? body.length;
	return new Uint8Array([
		...SIGNATURE,
		0x20 | command,
		(family << 4) | transport,
		length >> 8,
		length & 0xff,
		...body,
	]);
}

/** An address's bytes as written in a v2 header: an IPv4-mapped address stays 16 bytes. */
function addressOf(text: string): Uint8Array {
	const bytes = addressBytes(text) as Uint8Array;
	if (!text.includes(':') || bytes.length === 16) return bytes;
	return new Uint8Array([...Array(10).fill(0), 0xff, 0xff, ...bytes]);
}

export function concat(...parts: (Uint8Array | string)[]): Uint8Array {
	const bytes = parts.map((part) =>
		typeof part === 'string' ? new TextEncoder().encode(part) : part,
	);
	const all = new Uint8Array(bytes.reduce((sum, one) => sum + one.length, 0));
	let at = 0;
	for (const one of bytes) {
		all.set(one, at);
		at += one.length;
	}
	return all;
}
