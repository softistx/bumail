/**
 * The MX: mail for `example.test` from anyone, into the store. It relays
 * nothing: `@bumail/smtp` refuses a recipient outside `localDomains`
 * before any hook is asked. SPF is checked at MAIL FROM and DKIM once the
 * message is read; both go on top as an Authentication-Results field
 * (RFC 8601).
 */
import {
	checkSpf,
	type DkimResult,
	type SpfResult,
	verifyDkim,
} from '@bumail/auth';
import type { Resolver } from '@bumail/dns';
import { createSmtpServer, reply, type SmtpServer } from '@bumail/smtp';
import { concat } from './bytes';
import { DOMAIN, HOSTNAME } from './config';
import type { Mailboxes } from './mailboxes';
import type { Tls } from './tls';

export function createMx(
	mailboxes: Mailboxes,
	resolver: Resolver,
	tls: Tls,
	log: (line: string) => void,
): SmtpServer {
	return createSmtpServer({
		hostname: HOSTNAME,
		mode: 'mx',
		localDomains: [DOMAIN],
		tls,
		async onMailFrom(path, session) {
			session.data['spf'] = await checkSpf(
				{
					ip: session.remoteAddress,
					mailFrom: path.address,
					helo: session.helo ?? '',
				},
				{ resolver },
			);
		},
		async onRcptTo(path) {
			if ((await mailboxes.accountOf(path.address)) === undefined) {
				return reply(550, '5.1.1', 'No such user here');
			}
			return undefined;
		},
		async onData(message, session) {
			const bytes = await new Response(message.content).bytes();
			const dkim = await verifyDkim(bytes, { resolver });
			const results = authenticationResults(
				session.data['spf'] as SpfResult | undefined,
				message.envelope.from,
				dkim,
			);
			const content = concat(results, bytes);
			if (message.signal.aborted) return;
			for (const recipient of message.envelope.to) {
				const accountId = await mailboxes.accountOf(recipient);
				if (accountId !== undefined)
					await mailboxes.deliver(accountId, content);
			}
			log(
				`mx         ${message.envelope.from || '<>'} → ${message.envelope.to.join(', ')} (${bytes.length} bytes)`,
			);
		},
		onError: (error, session) => log(`mx error   ${session.id} ${error}`),
	});
}

/** The Authentication-Results field, CRLF included, in RFC 8601 §2.2's form. */
function authenticationResults(
	spf: SpfResult | undefined,
	mailFrom: string,
	dkim: readonly DkimResult[],
): string {
	const parts: string[] = [];
	if (spf !== undefined) {
		parts.push(`spf=${spf.result} smtp.mailfrom=${mailFrom || 'postmaster'}`);
	}
	for (const result of dkim) {
		const tags =
			result.result === 'none'
				? ''
				: ` header.d=${result.domain} header.s=${result.selector}`;
		parts.push(`dkim=${result.result}${tags}`);
	}
	return `Authentication-Results: ${HOSTNAME};\r\n\t${parts.join(';\r\n\t')}\r\n`;
}
