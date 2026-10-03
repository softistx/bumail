import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { signDkim } from '../dkim/sign';
import { verifyDkim } from '../dkim/verify';
import { formatAuthenticationResults } from '../results/authentication-results';
import { checkSpf } from '../spf/check-spf';
import { checkDmarc } from './check-dmarc';

/** The README's example: DKIM, SPF, DMARC, then the header, for one message. */
describe('verifyDkim + checkSpf + checkDmarc + formatAuthenticationResults', async () => {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const p = new Uint8Array(
		await crypto.subtle.exportKey('raw', pair.publicKey),
	).toBase64();
	const resolver = fixtureResolver({
		'sel._domainkey.example.com': { txt: [`v=DKIM1; k=ed25519; p=${p}`] },
		'bounces.example.com': { txt: ['v=spf1 ip4:192.0.2.0/24 -all'] },
		'_dmarc.example.com': {
			txt: ['v=DMARC1; p=reject; rua=mailto:d@example.com'],
		},
	});
	const now = () => 1_700_000_000_000;
	const body =
		'From: Joe <joe@news.example.com>\r\nTo: you@example.org\r\nSubject: hi\r\n\r\nHello.\r\n';
	const session = {
		ip: '192.0.2.10',
		mailFrom: 'b@bounces.example.com',
		helo: 'mx.example.com',
	};

	async function receive(message: string, ip = session.ip) {
		const dkim = await verifyDkim(message, { resolver, now });
		const spf = {
			result: await checkSpf({ ...session, ip }, { resolver }),
			identity: 'mailfrom' as const,
		};
		const dmarc = await checkDmarc({ message, dkim, spf }, { resolver });
		return {
			dmarc,
			field: formatAuthenticationResults('mx.example.org', {
				dkim,
				spf,
				dmarc,
			}),
		};
	}

	test('a signed message from a listed IP passes both ways', async () => {
		const signature = await signDkim(body, {
			domain: 'example.com',
			selector: 'sel',
			privateKey: pair.privateKey,
			now,
		});
		const { dmarc, field } = await receive(signature + body);
		expect(dmarc).toMatchObject({
			result: 'pass',
			domain: 'news.example.com',
			policyDomain: 'example.com',
			alignedDkim: 'example.com',
			alignedSpf: 'bounces.example.com',
			disposition: 'none',
		});
		const unfolded = field.replace(/\r\n(?=[ \t])/g, '');
		expect(unfolded).toStartWith(
			'Authentication-Results: mx.example.org; dkim=pass header.d=example.com header.s=sel header.b=',
		);
		expect(unfolded).toEndWith(
			'; spf=pass smtp.mailfrom=bounces.example.com; dmarc=pass header.from=news.example.com\r\n',
		);
	});

	test('a forgery from another IP, unsigned, is rejected', async () => {
		const { dmarc, field } = await receive(body, '198.51.100.7');
		expect(dmarc).toMatchObject({ result: 'fail', disposition: 'reject' });
		expect(field.replace(/\r\n(?=[ \t])/g, '')).toBe(
			'Authentication-Results: mx.example.org; dkim=none; spf=fail smtp.mailfrom=bounces.example.com; dmarc=fail header.from=news.example.com\r\n',
		);
	});
});
