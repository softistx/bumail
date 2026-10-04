import {
	checkDmarc,
	checkSpf,
	type DkimResult,
	type DmarcResult,
	formatAuthenticationResults,
	type SpfResult,
	verifyDkim,
} from '@bumail/auth';
import type { Resolver } from '@bumail/dns';
import type { InboundConfig } from '../config/types';

/** Milliseconds SPF and DMARC each have for their DNS lookups, at most. */
export const CHECK_TIMEOUT_MS = 10_000;

/** What the sender's checks say, and what the server does with the message. */
export interface Verdict {
	readonly dkim: readonly DkimResult[];
	readonly spf: SpfResult | undefined;
	readonly dmarc: DmarcResult;
	/** The `Authentication-Results` field to put on top, CRLF included. */
	readonly field: string;
	/**
	 * `deliver` to INBOX, `junk` to Junk (`p=quarantine`, enforced),
	 * `reject` with 550 (`p=reject`, enforced), `defer` with 451 (DMARC
	 * could not be had, enforced).
	 */
	readonly action: 'deliver' | 'junk' | 'reject' | 'defer';
}

/** The client and envelope SPF checks: who connected, what they said. */
export interface SpfInput {
	readonly ip: string;
	readonly mailFrom: string;
	readonly helo: string;
}

/**
 * SPF for MAIL FROM (or, for a bounce, the HELO name) — begun at MAIL
 * FROM and awaited at the end of DATA. Never rejects: an address the
 * check cannot take, such as no IP at all, is no check.
 */
export function startSpf(
	input: SpfInput,
	resolver: Resolver,
): Promise<SpfResult | undefined> {
	return checkSpf(input, { resolver, timeout: CHECK_TIMEOUT_MS }).catch(
		() => undefined,
	);
}

/**
 * DKIM over the whole message, then DMARC over its header, with the SPF
 * result; and what `inbound.dmarc` makes of them. `enforce` refuses
 * `p=reject` and sends `p=quarantine` to Junk; `mark` only records.
 */
export async function judge(
	message: {
		readonly header: Uint8Array;
		readonly whole: () => ReadableStream<Uint8Array>;
	},
	spf: SpfResult | undefined,
	options: {
		readonly hostname: string;
		readonly resolver: Resolver;
		readonly mode: InboundConfig['dmarc'];
	},
): Promise<Verdict> {
	const { resolver } = options;
	const dkim = await verifyDkim(message.whole(), { resolver });
	const spfCheck =
		spf === undefined
			? undefined
			: { result: spf, identity: 'mailfrom' as const };
	// The fields, then the blank line that ends them: DMARC reads From alone.
	const header = new Uint8Array(message.header.length + 2);
	header.set(message.header);
	header.set([0x0d, 0x0a], message.header.length);
	const dmarc = await checkDmarc(
		{
			message: header,
			dkim,
			...(spfCheck === undefined ? {} : { spf: spfCheck }),
		},
		{ resolver, timeout: CHECK_TIMEOUT_MS },
	);
	const field = formatAuthenticationResults(options.hostname, {
		dkim,
		...(spfCheck === undefined ? {} : { spf: spfCheck }),
		dmarc,
	});
	return { dkim, spf, dmarc, field, action: actionOf(dmarc, options.mode) };
}

function actionOf(
	dmarc: DmarcResult,
	mode: InboundConfig['dmarc'],
): Verdict['action'] {
	if (mode === 'mark') return 'deliver';
	if (dmarc.result === 'temperror') return 'defer';
	if (dmarc.disposition === 'reject') return 'reject';
	if (dmarc.disposition === 'quarantine') return 'junk';
	return 'deliver';
}
