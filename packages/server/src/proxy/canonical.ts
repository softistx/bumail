import { addressBytes, formatAddress } from './address';

/**
 * An address as the one text a client is counted and logged under, by
 * every listener: RFC 5952's form, an IPv4-mapped address as its IPv4
 * address; `undefined` for anything that is no address, a zone included.
 */
export function canonical(text: string): string | undefined {
	const bytes = addressBytes(text);
	return bytes === undefined ? undefined : formatAddress(bytes);
}
