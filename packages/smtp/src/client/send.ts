import { SmtpError } from '../errors';
import { type Content, contentOf } from './content';
import { addressesOf, noAddress, resolveMx } from './mx';
import type {
	MessageSource,
	MxDestination,
	SendMailOptions,
	SendMailResult,
} from './options';
import { open } from './session';
import { type ClientSettings, portOf, settingsOf } from './settings';
import { ClientSocket } from './socket';
import { Clock, type Endpoint, type TlsTarget } from './target';
import { transact } from './transaction';

/** The most addresses one delivery tries, every MX host together. */
export const MAX_ADDRESSES = 10;

/** Seconds to wait for the 221 to QUIT once the message was taken. */
const QUIT_WAIT = 5;

/** Errors from before MAIL FROM: another MX host may do better. */
const early = new WeakSet<object>();

const invalid = (message: string) =>
	new SmtpError('INVALID_OPTION', `sendMail(): ${message}`);

/** One session with one server, from the connection to QUIT. */
async function attempt(
	endpoint: Endpoint,
	settings: ClientSettings,
	content: Content,
	clock: Clock,
): Promise<SendMailResult> {
	const tls: TlsTarget = {
		servername: endpoint.host,
		verify: settings.tls === 'required',
		...(settings.ca ? { ca: settings.ca } : {}),
	};
	let socket: ClientSocket;
	try {
		socket = await ClientSocket.open(
			endpoint,
			settings.secure ? tls : undefined,
			settings.timeouts.connect,
			clock,
		);
	} catch (error) {
		early.add(error as object);
		throw error;
	}
	let quit = false;
	try {
		const ready = await open(socket, settings, tls).catch((error) => {
			early.add(error as object);
			throw error;
		});
		const delivered = await transact(socket, settings, content, ready);
		socket.write('QUIT\r\n');
		quit = true;
		await socket
			.reply(
				'the reply to QUIT',
				Math.min(QUIT_WAIT, settings.timeouts.command),
			)
			.catch(() => {});
		return {
			...delivered,
			host: endpoint.host,
			port: endpoint.port,
			tls: socket.secure ? { verified: socket.verified } : false,
			authenticated: ready.authenticated,
		};
	} finally {
		// After a refusal the session is still in step: say goodbye.
		if (!quit) socket.write('QUIT\r\n');
		socket.close();
	}
}

/** Direct delivery: each MX host's addresses in turn, while the failures are temporary and before MAIL FROM. */
async function viaMx(
	options: MxDestination,
	settings: ClientSettings,
	content: Content,
	clock: Clock,
): Promise<SendMailResult> {
	const { domain, resolver } = options;
	if (typeof domain !== 'string' || domain === '')
		throw invalid('domain must be a domain name');
	if (typeof resolver?.mx !== 'function')
		throw invalid('resolver must be a Resolver, such as @bumail/dns gives');
	const port = portOf(options.port, 25);
	let last: unknown;
	let dnsError: unknown;
	let tried = 0;
	for (const mx of await resolveMx(domain, resolver)) {
		const addresses = await addressesOf(mx.host, resolver);
		if (!Array.isArray(addresses)) {
			dnsError = addresses.error;
			continue;
		}
		for (const address of addresses) {
			if (tried++ >= MAX_ADDRESSES) break;
			try {
				return await attempt(
					{ host: mx.host, address, port },
					settings,
					content,
					clock,
				);
			} catch (error) {
				const next =
					error instanceof SmtpError && error.temporary && early.has(error);
				if (!next) throw error;
				last = error;
			}
		}
	}
	throw last ?? noAddress(domain, dnsError);
}

/**
 * Delivers one message to one destination: a host (`{ host, port }`, a
 * smarthost or a submission server) or a domain's mail hosts (`{ domain,
 * resolver }`, by MX). Resolves once the server took the message for one
 * recipient at least; rejects with an `SmtpError` otherwise, `temporary`
 * telling whether to try again later. It is not a queue: retries are the
 * caller's.
 */
export async function sendMail(
	message: MessageSource,
	options: SendMailOptions,
): Promise<SendMailResult> {
	const settings = settingsOf(options);
	const content = contentOf(message, settings.normalizeLineEnds, settings.size);
	const clock = new Clock(settings.deadline);
	if ('host' in options && options.host !== undefined) {
		const { host } = options;
		if (typeof host !== 'string' || !/^[^\s/]+$/.test(host))
			throw invalid(`host must be a host name or an address, not ${host}`);
		const port = portOf(options.port, settings.secure ? 465 : 25);
		return attempt({ host, address: host, port }, settings, content, clock);
	}
	return viaMx(options as MxDestination, settings, content, clock);
}
