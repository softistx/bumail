import type { Sender } from '@bumail/queue';
import { type SendMailResult, sendMail } from '@bumail/smtp/client';
import type { Directory } from '../../directory/directory';
import { type DeliveryContext, deliverContent } from '../mx/deliver';
import { usersFor } from '../recipients';

/** What the queue needs to deliver to the server's own users. */
export interface LocalContext extends DeliveryContext {
	readonly hostname: string;
	readonly directory: Directory;
	/** `postmaster` from the configuration. */
	readonly postmaster: string | undefined;
	/** Keeps a delivery under way, so a stop waits for it before closing the store. */
	track<T>(work: Promise<T>): Promise<T>;
}

const encoder = new TextEncoder();

/** The domain of `address`, after its last `@`, lowercase. */
function domainOf(address: string): string {
	return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * The queue's `send`: recipients in a hosted domain go straight to the
 * store — a DSN back to a local sender above all, which must never leave
 * the server — and every other domain to `send` (`sendMail`), as the
 * route says. The queue groups recipients by domain, so one call is one
 * domain's.
 */
export function localFirst(ctx: LocalContext, send: Sender = sendMail): Sender {
	return (message, options) => {
		const to = [options.to].flat();
		const domain =
			'domain' in options && typeof options.domain === 'string'
				? options.domain
				: domainOf(to[0] ?? '');
		if (!ctx.directory.domains.has(domain)) return send(message, options);
		return ctx.track(deliverLocally(ctx, message, options.from, to));
	};
}

/**
 * Adds `message` to each recipient's users' INBOX, `Return-Path` on top;
 * a recipient nobody here has is refused with `550 5.1.1`, as the MX
 * would. A store failure rejects, which the queue counts as temporary.
 */
async function deliverLocally(
	ctx: LocalContext,
	message: Uint8Array,
	from: string,
	to: readonly string[],
): Promise<SendMailResult> {
	const returnPath = encoder.encode(`Return-Path: <${from}>\r\n`);
	const content = new Uint8Array(returnPath.length + message.length);
	content.set(returnPath);
	content.set(message, returnPath.length);
	const accepted: SendMailResult['accepted'][number][] = [];
	const rejected: SendMailResult['rejected'][number][] = [];
	const ok = { code: 250, status: '2.0.0', text: 'Delivered here' };
	for (const recipient of to) {
		const users = usersFor(ctx.directory, recipient, ctx.postmaster);
		if (users === undefined) {
			rejected.push({
				recipient,
				reply: { code: 550, status: '5.1.1', text: 'User unknown' },
			});
			continue;
		}
		for (const user of users) await deliverContent(ctx, user, false, content);
		accepted.push({ recipient, reply: ok });
	}
	return {
		accepted,
		rejected,
		reply: ok,
		host: ctx.hostname,
		port: 0,
		tls: false,
		authenticated: false,
	};
}
