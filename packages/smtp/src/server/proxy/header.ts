import { addressBytes, formatAddress } from './address';

/**
 * The PROXY protocol header (HAProxy's proxy-protocol.txt, versions 1 and
 * 2) a TCP proxy sends before anything of the client's, read from the
 * bytes received so far. `source` is the client's address, or absent to
 * keep the peer's: a v2 LOCAL (a health check from the proxy itself), an
 * UNSPEC, UNIX or datagram address, a v1 UNKNOWN.
 */
export type ProxyHeader =
	| { readonly status: 'partial' }
	| { readonly status: 'invalid'; readonly reason: string }
	| {
			readonly status: 'complete';
			/** Bytes of the header: what follows is the client's. */
			readonly length: number;
			readonly source?: string;
	  };

/** A v1 line, CRLF included, is 107 bytes at most. */
export const MAX_V1_LENGTH = 107;
/** v2's addresses take 216 bytes at most (two UNIX paths); TLVs past this are refused. */
export const MAX_TLV_BYTES = 2048;
/** The longest header read: past it, whatever the bytes, the header is refused. */
export const MAX_HEADER_LENGTH = 16 + 216 + MAX_TLV_BYTES;

const V1_PREFIX = new TextEncoder().encode('PROXY ');
const V2_SIGNATURE = new Uint8Array([
	0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
/** v2 address block length by family: UNSPEC, INET, INET6, UNIX. */
const ADDRESS_LENGTH = [0, 12, 36, 216] as const;

const PARTIAL = { status: 'partial' } as const;
const invalid = (reason: string) => ({ status: 'invalid', reason }) as const;

/** The bytes so far agree with `prefix` as far as both go. */
function startsAs(bytes: Uint8Array, prefix: Uint8Array): boolean {
	const length = Math.min(bytes.length, prefix.length);
	for (let at = 0; at < length; at++) {
		if (bytes[at] !== prefix[at]) return false;
	}
	return true;
}

export function readProxyHeader(bytes: Uint8Array): ProxyHeader {
	if (bytes.length === 0) return PARTIAL;
	if (startsAs(bytes, V2_SIGNATURE)) return readV2(bytes);
	if (startsAs(bytes, V1_PREFIX)) return readV1(bytes);
	return invalid('no PROXY protocol signature');
}

function readV2(bytes: Uint8Array): ProxyHeader {
	if (bytes.length < 16) return PARTIAL;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const versionCommand = view.getUint8(12);
	if (versionCommand >> 4 !== 2) return invalid('not version 2');
	const command = versionCommand & 0x0f;
	if (command > 1) return invalid(`unknown command ${command}`);
	const family = view.getUint8(13) >> 4;
	const transport = view.getUint8(13) & 0x0f;
	const length = view.getUint16(14);
	// LOCAL: the proxy's own connection; its address block is ignored.
	const addresses = command === 0 ? 0 : ADDRESS_LENGTH[family as 0 | 1 | 2 | 3];
	if (addresses === undefined || transport > 2) {
		return invalid('unknown address family or transport');
	}
	if (length < addresses) return invalid('address block too short');
	// Refused from the first 16 bytes, before any of it is waited for.
	if (length - addresses > MAX_TLV_BYTES) return invalid('TLVs too long');
	const total = 16 + length;
	if (bytes.length < total) return PARTIAL;
	if (command === 0) return { status: 'complete', length: total };
	const tlvs = bytes.subarray(16 + addresses, total);
	if (!wellFormedTlvs(tlvs)) return invalid('malformed TLV');
	// Only a TCP client over IPv4 or IPv6 replaces the peer's address.
	if (transport !== 1 || (family !== 1 && family !== 2)) {
		return { status: 'complete', length: total };
	}
	const size = family === 1 ? 4 : 16;
	const source = formatAddress(bytes.slice(16, 16 + size));
	return { status: 'complete', length: total, source };
}

/** Each TLV — a type, a 16-bit length, its value — ends within the block: skipped, never read. */
function wellFormedTlvs(block: Uint8Array): boolean {
	let at = 0;
	while (at < block.length) {
		if (at + 3 > block.length) return false;
		const length = ((block[at + 1] as number) << 8) | (block[at + 2] as number);
		at += 3 + length;
	}
	return at === block.length;
}

const PORT = /^(0|[1-9]\d{0,4})$/;

function readV1(bytes: Uint8Array): ProxyHeader {
	const end = bytes.indexOf(0x0a);
	if (end < 0) {
		return bytes.length >= MAX_V1_LENGTH
			? invalid('v1 line too long')
			: PARTIAL;
	}
	if (end + 1 > MAX_V1_LENGTH) return invalid('v1 line too long');
	if (bytes[end - 1] !== 0x0d) return invalid('v1 line without CRLF');
	const line = bytes.subarray(0, end - 1);
	if (line.some((byte) => byte < 0x20 || byte > 0x7e)) {
		return invalid('v1 line not printable');
	}
	const [, protocol, ...rest] = new TextDecoder().decode(line).split(' ');
	if (protocol === 'UNKNOWN') return { status: 'complete', length: end + 1 };
	const [source = '', destination = '', sourcePort = '', port = ''] = rest;
	const size = protocol === 'TCP4' ? 4 : protocol === 'TCP6' ? 16 : 0;
	if (size === 0) return invalid('v1 protocol not TCP4, TCP6 or UNKNOWN');
	const from = rawAddress(source, size);
	if (
		rest.length !== 4 ||
		!from ||
		!rawAddress(destination, size) ||
		!validPort(sourcePort) ||
		!validPort(port)
	) {
		return invalid('v1 addresses or ports malformed');
	}
	return { status: 'complete', length: end + 1, source: formatAddress(from) };
}

/** The bytes of `text` written as an address of `size` bytes: no IPv4-mapped shortcut for TCP6. */
function rawAddress(text: string, size: number): Uint8Array | undefined {
	if (size === 4 && text.includes(':')) return undefined;
	if (size === 16 && !text.includes(':')) return undefined;
	return addressBytes(text);
}

function validPort(text: string): boolean {
	return PORT.test(text) && Number(text) <= 65_535;
}
