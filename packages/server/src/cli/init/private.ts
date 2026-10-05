import { isIP } from 'node:net';

/**
 * Whether `entry` (an address or a CIDR) is in a private, loopback or
 * link-local range: where a Docker network lives. A proxy list reaching
 * beyond those trusts addresses anyone on the Internet may hold.
 */
export function isPrivateRange(entry: string): boolean {
	const address = entry.split('/')[0] ?? '';
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	const text = mapped ?? address;
	if (isIP(text) === 4) {
		const [a = 0, b = 0] = text.split('.').map(Number);
		return (
			a === 10 ||
			a === 127 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254)
		);
	}
	if (isIP(text) === 6) {
		const first = Number.parseInt(text.split(':')[0] || '0', 16);
		return (
			text === '::1' ||
			(first & 0xfe00) === 0xfc00 ||
			(first & 0xffc0) === 0xfe80
		);
	}
	return false;
}
