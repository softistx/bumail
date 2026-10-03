import { type FixtureRecords, fixtureResolver } from '@bumail/dns';
import type { DkimResult } from '../dkim/result';
import type { SpfResult } from '../spf/result';
import { type CheckDmarcOptions, checkDmarc } from './check-dmarc';
import type { DmarcResult, SpfCheck } from './result';

/** A message with these From fields, one field per entry. */
export function messageFrom(...froms: string[]): string {
	const fields = froms.map((from) => `From: ${from}\r\n`).join('');
	return `${fields}To: receiver@example.org\r\nSubject: here's a sample\r\n\r\nHello!\r\n`;
}

/** A DKIM result for `d=domain`. */
export function dkim(
	domain: string,
	result: DkimResult['result'] = 'pass',
): DkimResult {
	return {
		result,
		domain,
		selector: 'sel',
		signature: 'abc/+=',
		testing: false,
	};
}

/** An SPF result for `domain`, checked for the MAIL FROM identity unless told otherwise. */
export function spf(
	domain: string,
	result: SpfResult['result'] = 'pass',
	identity: SpfCheck['identity'] = 'mailfrom',
): SpfCheck {
	return {
		result: { result, reason: 'spec', domain, lookups: 0 },
		identity,
	};
}

/** What a check gives for a sender, with the DNS given as records. */
export async function dmarcOf(
	records: FixtureRecords,
	from: string,
	auth: { dkim?: DkimResult[]; spf?: SpfCheck } = {},
	options: Partial<CheckDmarcOptions> = {},
): Promise<DmarcResult> {
	return checkDmarc(
		{
			message: messageFrom(from),
			dkim: auth.dkim ?? [],
			...(auth.spf === undefined ? {} : { spf: auth.spf }),
		},
		{ resolver: fixtureResolver(records), ...options },
	);
}

/** `_dmarc.<domain>` holding `record`. */
export function published(
	domain: string,
	...records: string[]
): FixtureRecords {
	return { [`_dmarc.${domain}`]: { txt: records } };
}
