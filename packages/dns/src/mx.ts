import type { MxRecord } from './types';

/**
 * Whether a domain's MX answer is a null MX (RFC 7505): a single record
 * whose exchange is the root (`0 .`), saying the domain accepts no mail.
 * A sender gives up at once, with no fallback to the domain's address.
 */
export function isNullMx(records: readonly MxRecord[]): boolean {
	return records.length === 1 && records[0]?.exchange === '';
}
