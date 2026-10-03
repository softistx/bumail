import { SmtpError } from '../errors';
import { parseEhlo } from '../protocol/ehlo';
import { encodeLoginStep, encodePlain } from '../protocol/sasl';
import { refused, shown } from './refusal';
import type { ClientSettings } from './settings';
import type { ClientSocket } from './socket';
import type { TlsTarget } from './target';

/** A session past its greeting, EHLO, STARTTLS and AUTH: what the server offers. */
export interface Ready {
	readonly extensions: ReadonlyMap<string, string>;
	readonly authenticated: boolean;
}

/** EHLO, or HELO when the server refuses EHLO with a 5xx (RFC 5321 §4.1.4). */
async function hello(
	socket: ClientSocket,
	settings: ClientSettings,
	allowHelo: boolean,
): Promise<ReadonlyMap<string, string>> {
	const seconds = settings.timeouts.command;
	socket.write(`EHLO ${settings.helo}\r\n`);
	const ehlo = await socket.reply('the reply to EHLO', seconds);
	if (ehlo.code === 250) {
		return parseEhlo(typeof ehlo.text === 'string' ? [ehlo.text] : ehlo.text);
	}
	if (ehlo.code < 500 || !allowHelo) throw refused(socket.host, 'EHLO', ehlo);
	socket.write(`HELO ${settings.helo}\r\n`);
	const helo = await socket.reply('the reply to HELO', seconds);
	if (helo.code !== 250) throw refused(socket.host, 'HELO', helo);
	return new Map();
}

/** STARTTLS when offered (RFC 3207); `required` fails without it, `opportunistic` goes on in clear. */
async function startTls(
	socket: ClientSocket,
	settings: ClientSettings,
	tls: TlsTarget,
	extensions: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
	const required = settings.tls === 'required';
	if (!extensions.has('STARTTLS')) {
		if (!required) return extensions;
		throw new SmtpError(
			'TLS_UNAVAILABLE',
			`${socket.host} does not offer STARTTLS, and tls is 'required'`,
		);
	}
	socket.write('STARTTLS\r\n');
	const answer = await socket.reply(
		'the reply to STARTTLS',
		settings.timeouts.command,
	);
	if (answer.code !== 220) {
		if (!required) return extensions;
		throw new SmtpError(
			'TLS_UNAVAILABLE',
			`${socket.host} refused STARTTLS, and tls is 'required': ${shown(answer)}`,
			{ reply: answer, temporary: true },
		);
	}
	await socket.startTls(tls, settings.timeouts.connect);
	// RFC 3207 §4.2: what was learnt in clear is forgotten; EHLO again.
	return hello(socket, settings, false);
}

/** AUTH PLAIN or LOGIN (RFC 4954), over TLS unless `allowPlaintextAuth`. */
async function authenticate(
	socket: ClientSocket,
	settings: ClientSettings,
	extensions: ReadonlyMap<string, string>,
): Promise<void> {
	const { auth } = settings;
	if (!auth) return;
	const { host } = socket;
	if (!socket.secure && !settings.allowPlaintextAuth) {
		throw new SmtpError(
			'AUTH_UNAVAILABLE',
			`Refusing to send credentials to ${host} in clear: it did not start TLS (allowPlaintextAuth is for a local test server only)`,
		);
	}
	const offered = (extensions.get('AUTH') ?? '').toUpperCase().split(' ');
	const mechanism =
		auth.mechanism ??
		(offered.includes('PLAIN')
			? 'PLAIN'
			: offered.includes('LOGIN')
				? 'LOGIN'
				: undefined);
	if (!mechanism || !offered.includes(mechanism)) {
		throw new SmtpError(
			'AUTH_UNAVAILABLE',
			`${host} offers no AUTH mechanism this client speaks (${auth.mechanism ?? 'PLAIN, LOGIN'}): AUTH ${extensions.get('AUTH') ?? 'is not offered'}`,
		);
	}
	const seconds = settings.timeouts.command;
	const steps =
		mechanism === 'PLAIN'
			? [`AUTH PLAIN ${encodePlain(auth.username, auth.password)}`]
			: [
					'AUTH LOGIN',
					encodeLoginStep(auth.username),
					encodeLoginStep(auth.password),
				];
	for (const [i, step] of steps.entries()) {
		socket.write(`${step}\r\n`);
		const answer = await socket.reply('the reply to AUTH', seconds);
		const last = i === steps.length - 1;
		if (answer.code === (last ? 235 : 334)) continue;
		throw refused(host, `AUTH ${mechanism}`, answer);
	}
}

/** The greeting, EHLO, STARTTLS and AUTH: a session ready for MAIL FROM. */
export async function open(
	socket: ClientSocket,
	settings: ClientSettings,
	tls: TlsTarget,
): Promise<Ready> {
	const greeting = await socket.reply(
		'the greeting',
		settings.timeouts.greeting,
	);
	if (greeting.code !== 220) {
		throw refused(socket.host, 'the connection', greeting);
	}
	let extensions = await hello(socket, settings, true);
	if (!socket.secure && settings.tls !== 'none') {
		extensions = await startTls(socket, settings, tls, extensions);
	}
	await authenticate(socket, settings, extensions);
	return { extensions, authenticated: settings.auth !== undefined };
}
