/**
 * Submission: mail from alice, to anywhere. STARTTLS first, then AUTH —
 * `@bumail/smtp` offers AUTH only once encrypted, and `mode:
 * 'submission'` refuses MAIL until the session authenticated. Each message
 * is DKIM-signed for `example.test`; local recipients get it in their
 * INBOX, the others through the smarthost (Mailpit by default).
 */
import { signDkim } from '@bumail/auth';
import { createSmtpServer, reply, type SmtpServer } from '@bumail/smtp';
import { SmtpError, sendMail } from '@bumail/smtp/client';
import { concat } from './bytes';
import { ADDRESS, DKIM_SELECTOR, DOMAIN, HOSTNAME } from './config';
import type { Mailboxes } from './mailboxes';
import type { Tls } from './tls';

export interface SubmissionOptions {
	readonly mailboxes: Mailboxes;
	readonly tls: Tls;
	readonly dkimKey: CryptoKey;
	readonly smarthost: { readonly host: string; readonly port: number };
	readonly log: (line: string) => void;
}

export function createSubmission({
	mailboxes,
	tls,
	dkimKey,
	smarthost,
	log,
}: SubmissionOptions): SmtpServer {
	return createSmtpServer({
		hostname: HOSTNAME,
		mode: 'submission',
		localDomains: [DOMAIN],
		tls,
		async authenticate({ username, password }) {
			return (await mailboxes.login(username, password)) !== undefined;
		},
		onMailFrom(path) {
			// One user, one address: alice sends as herself only.
			if (path.address.toLowerCase() !== ADDRESS) {
				return reply(553, '5.7.1', `Send as ${ADDRESS} only`);
			}
			return undefined;
		},
		async onRcptTo(path) {
			if (
				path.domain === DOMAIN &&
				(await mailboxes.accountOf(path.address)) === undefined
			) {
				return reply(550, '5.1.1', 'No such user here');
			}
			return undefined;
		},
		async onData(message) {
			const bytes = await new Response(message.content).bytes();
			const signature = await signDkim(bytes, {
				domain: DOMAIN,
				selector: DKIM_SELECTOR,
				privateKey: dkimKey,
			});
			const signed = concat(signature, bytes);
			if (message.signal.aborted) return undefined;

			const { from, to } = message.envelope;
			const local = to.filter((address) =>
				address.toLowerCase().endsWith(`@${DOMAIN}`),
			);
			const remote = to.filter((address) => !local.includes(address));
			if (remote.length > 0) {
				try {
					const result = await sendMail(signed, {
						...smarthost,
						from,
						to: remote,
						helo: HOSTNAME,
					});
					log(
						`submission ${from} → ${remote.join(', ')} via ${result.host}:${result.port}: ${result.reply.code}`,
					);
				} catch (error) {
					const text = error instanceof SmtpError ? error.message : `${error}`;
					log(`submission smarthost failed: ${text}`);
					return reply(
						451,
						'4.4.1',
						'The smarthost did not take it, try later',
					);
				}
			}
			for (const recipient of local) {
				const accountId = await mailboxes.accountOf(recipient);
				if (accountId !== undefined) await mailboxes.deliver(accountId, signed);
			}
			if (local.length > 0) {
				log(`submission ${from} → ${local.join(', ')} (local)`);
			}
			return undefined;
		},
		onError: (error, session) => log(`submission error ${session.id} ${error}`),
	});
}
