import {
	type FixtureRecords,
	fixtureResolver,
	type Resolver,
} from '@bumail/dns';
import { parseClientIp } from './ip';
import type { Run } from './run';

/**
 * RFC 7208 Appendix A's DNS, as printed, with `example.com`'s SPF record
 * left to the spec. `www`'s CNAME is left out: no example uses it.
 */
export function appendixA(
	record: string,
	more: FixtureRecords = {},
): FixtureRecords {
	return {
		'example.com': {
			txt: [record],
			mx: [
				{ exchange: 'mail-a.example.com', priority: 10 },
				{ exchange: 'mail-b.example.com', priority: 20 },
			],
			a: ['192.0.2.10', '192.0.2.11'],
		},
		'amy.example.com': { a: ['192.0.2.65'] },
		'bob.example.com': { a: ['192.0.2.66'] },
		'mail-a.example.com': { a: ['192.0.2.129'] },
		'mail-b.example.com': { a: ['192.0.2.130'] },
		'example.org': { mx: [{ exchange: 'mail-c.example.org', priority: 10 }] },
		'mail-c.example.org': { a: ['192.0.2.140'] },
		'192.0.2.10': { ptr: ['example.com'] },
		'192.0.2.11': { ptr: ['example.com'] },
		'192.0.2.65': { ptr: ['amy.example.com'] },
		'192.0.2.66': { ptr: ['bob.example.com'] },
		'192.0.2.129': { ptr: ['mail-a.example.com'] },
		'192.0.2.130': { ptr: ['mail-b.example.com'] },
		'192.0.2.140': { ptr: ['mail-c.example.org'] },
		'10.0.0.4': { ptr: ['bob.example.com'] },
		...more,
	};
}

/** A check's state for unit specs of the expander and the evaluator. */
export function runOf(
	ip: string,
	sender = 'strong-bad@email.example.com',
	resolver: Resolver = fixtureResolver({}),
): Run {
	const at = sender.lastIndexOf('@');
	return {
		resolver,
		ip: parseClientIp(ip) as Uint8Array,
		sender,
		local: sender.slice(0, at),
		senderDomain: sender.slice(at + 1),
		helo: 'mx.example.org',
		receiver: 'mx.example.net',
		now: 1_400_000_000,
		deadline: performance.now() + 10_000,
		timeout: 10_000,
		lookups: 0,
		voids: 0,
	};
}
