/**
 * The demo's DNS: a fixture, so nothing leaves the machine. It holds the
 * records a real deployment would publish for `example.test`, and those
 * of one outside sender, `sender.test`, whose mail the MX checks.
 */
import { fixtureResolver, type Resolver } from '@bumail/dns';
import { DKIM_SELECTOR, DOMAIN } from './config';

/** The outside sender whose mail the MX checks with SPF and DKIM. */
export const SENDER_DOMAIN = 'sender.test';
export const SENDER_SELECTOR = 'brisbane';
/**
 * RFC 8463 §A.2's published Ed25519 test key: public, so only ever a
 * fixture. The e2e signs `sender.test`'s mail with it.
 */
export const SENDER_PRIVATE_KEY =
	'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=';
const SENDER_PUBLIC_KEY = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

/** Loopback may send for both domains: the demo and the e2e run on it. */
const LOOPBACK_SPF = 'v=spf1 ip4:127.0.0.1 ip6:::1 -all';

/** The TXT record that publishes a DKIM Ed25519 public key. */
export function dkimRecord(publicKey: string): string {
	return `v=DKIM1; k=ed25519; p=${publicKey}`;
}

/** `demoPublicKey`: the key the submission server signs with. */
export function demoResolver(demoPublicKey: string): Resolver {
	return fixtureResolver({
		[DOMAIN]: {
			mx: [{ exchange: `mx.${DOMAIN}`, priority: 10 }],
			txt: [LOOPBACK_SPF],
		},
		[`${DKIM_SELECTOR}._domainkey.${DOMAIN}`]: {
			txt: [dkimRecord(demoPublicKey)],
		},
		[SENDER_DOMAIN]: { txt: [LOOPBACK_SPF] },
		[`${SENDER_SELECTOR}._domainkey.${SENDER_DOMAIN}`]: {
			txt: [dkimRecord(SENDER_PUBLIC_KEY)],
		},
	});
}
